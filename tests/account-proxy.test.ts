import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { browserProxyView, planAccountProxy, proxyForAccountTask, type ProxyResolverDb, type ProxyTaskRef } from "../src/engine/account-proxy"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { chooseSticky } from "../src/engine/proxy-hygiene"
import type { ProxyEndpoint, ProxyGroup, StickyPinLike } from "./account-proxy-types"

const secret = "hunter2-proxy-pass"
const endpoint = (id: string): ProxyEndpoint => ({ id, host: `${id}.example.net`, port: 8000, username: "user-" + id, password: secret })
const groupA: ProxyGroup = { id: "ga", name: "Pool A", network: "residential", proxies: [endpoint("a1"), endpoint("a2")] }
const groupB: ProxyGroup = { id: "gb", name: "Pool B", network: "residential", proxies: [endpoint("b1")] }
const empty: ProxyGroup = { id: "ge", name: "Empty", network: "datacenter", proxies: [] }
const task = (id: string, accountId: string, proxyGroupId: string | null, extra: Partial<ProxyTaskRef> = {}): ProxyTaskRef => ({ id, accountId, proxyGroupId, ...extra })

function fakeDb(tasks: ProxyTaskRef[], accountGroup: string | null, groups: ProxyGroup[]): ProxyResolverDb & { pins: StickyPinLike[] } {
  const state = { pins: [] as StickyPinLike[] }
  return {
    get pins() {
      return state.pins
    },
    listTasks: () => tasks,
    readAccount: (id) => ({ id, proxyGroupId: accountGroup }),
    getProxyGroup: (id) => {
      const found = groups.find((item) => item.id === id)
      if (!found) throw new Error("missing")
      return found
    },
    assignProxy: (accountId, groupId, proxies) => {
      const result = chooseSticky(proxies, state.pins as never, [], accountId, groupId, 0, true)
      state.pins = result.pins as never
      return result.choice
    },
    findProxy: (id) => groups.flatMap((item) => item.proxies).find((proxy) => proxy.id === id)
  }
}

describe("one proxy resolver for every account browser (0.2.44)", () => {
  it("the account's own group wins, otherwise the asking task's group", () => {
    expect(planAccountProxy({ id: "x", proxyGroupId: "ga" }, [task("t", "x", "gb")], "t")).toMatchObject({ groupId: "ga", source: "account", overriddenTaskGroupId: "gb" })
    expect(planAccountProxy({ id: "x" }, [task("t", "x", "gb")], "t")).toMatchObject({ groupId: "gb", source: "task" })
    expect(planAccountProxy({ id: "x" }, [task("t", "x", null), task("u", "x", "ga")], "t")).toMatchObject({ groupId: null, source: "none" })
  })

  it("without a named task it follows the account's tasks and flags different groups", () => {
    const tasks = [task("t", "x", "ga"), task("u", "x", "gb"), task("m", "x", "gb", { monitorOnly: true }), task("o", "y", "gb")]
    const plan = planAccountProxy({ id: "x" }, tasks)
    expect(plan.groupId).toBe("ga")
    expect(plan.conflictGroupIds).toEqual(["ga", "gb"])
    expect(planAccountProxy({ id: "x" }, [task("m", "x", "gb", { monitorOnly: true })]).groupId).toBeNull()
  })

  it("pins the account to one proxy and the window and the task get the same one every time", () => {
    const db = fakeDb([task("t", "x", "ga")], null, [groupA, groupB])
    const first = proxyForAccountTask(db, "x", "t")
    expect(first.proxy?.id).toBeTruthy()
    for (let run = 0; run < 5; run += 1) expect(proxyForAccountTask(db, "x").proxy?.id).toBe(first.proxy?.id)
    expect(proxyForAccountTask(db, "x", "t").directWithGroup).toBe(false)
  })

  it("never lets a window run direct while its task has a proxy group", () => {
    const missing = proxyForAccountTask(fakeDb([task("t", "x", "gone")], null, [groupA]), "x")
    expect(missing.directWithGroup).toBe(true)
    expect(missing.proxy).toBeUndefined()
    const noneFree = proxyForAccountTask(fakeDb([task("t", "x", "ge")], null, [empty]), "x")
    expect(noneFree.directWithGroup).toBe(true)
    const direct = proxyForAccountTask(fakeDb([task("t", "x", null)], null, [groupA]), "x", "t")
    expect(direct.directWithGroup).toBe(false)
    expect(direct.groupId).toBeNull()
  })

  it("keeps the sticky proxy when the group changes under it", () => {
    const db = fakeDb([task("t", "x", "ga")], null, [groupA, groupB])
    const first = proxyForAccountTask(db, "x", "t")
    const other = fakeDb([task("t", "x", "gb")], null, [groupA, groupB])
    other.pins.push({ accountId: "x", groupId: "ga", proxyId: first.proxy!.id, exclusive: true })
    const held = proxyForAccountTask(other, "x", "t")
    expect(held.proxy?.id).toBe(first.proxy?.id)
    expect(held.notes.join(" ")).toMatch(/sticky/i)
  })

  it("describes each browser profile for the Accounts page without credentials", () => {
    const groups = [groupA, groupB, empty]
    const acct = { id: "x" }
    expect(browserProxyView(acct, [], groups, null).status).toBe("direct")
    expect(browserProxyView(acct, [task("t", "x", "ga")], groups, null).status).toBe("pending")
    const bound = browserProxyView(acct, [task("t", "x", "ga")], groups, "a1")
    expect(bound).toMatchObject({ status: "bound", label: "a1.example.net:8000", groupName: "Pool A" })
    expect(browserProxyView(acct, [task("t", "x", "ge")], groups, null).status).toBe("direct-warning")
    expect(browserProxyView(acct, [task("t", "x", "gone")], groups, null).status).toBe("direct-warning")
    expect(browserProxyView(acct, [task("t", "x", "ga"), task("u", "x", "gb")], groups, "a1").status).toBe("conflict")
    const text = JSON.stringify([bound, browserProxyView(acct, [task("t", "x", "ga")], groups, null)])
    expect(text).not.toContain(secret)
    expect(text).not.toContain("user-a1")
  })

  it("the account list carries the binding from the real database", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-bind-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const group = db.saveProxyGroup({ name: "Bind", text: "p1.example.net:8000:u:secretpw\np2.example.net:8000:u:secretpw", network: "residential" })
    const saved = db.saveAccount({ store: "target", label: "A", username: "a@example.com", password: "", passwordAction: "clear", session: "", sessionAction: "clear", proxyGroupId: group.id })
    expect(db.listAccounts()[0]?.browserProxy?.status).toBe("pending")
    const choice = db.assignProxy(saved.id, group.id, group.proxies)
    const view = db.listAccounts()[0]?.browserProxy
    expect(view?.status).toBe("bound")
    expect(view?.label).toBe(`${choice.proxy?.host}:${choice.proxy?.port}`)
    expect(JSON.stringify(db.listAccounts())).not.toContain("secretpw")
  })

  it("every browser window asks the same resolver", () => {
    const sessionWindow = readFileSync("src/main/session-window.ts", "utf8")
    const runner = readFileSync("src/engine/task-runner.ts", "utf8")
    expect(sessionWindow).toContain("proxyForAccountTask(")
    expect(runner).toContain("planAccountProxy(")
    expect(sessionWindow).not.toMatch(/listTasks\(\)\.find\(\(task\) => task\.accountId === account\.id\)/)
    const challenge = readFileSync("src/main/challenge-window.ts", "utf8")
    expect(challenge).toContain("webContents.session !== ses")
    for (const file of [sessionWindow, runner, challenge]) {
      expect(file).not.toMatch(/console\.(log|info|warn)\([^)]*(password|username)/i)
      expect(file).not.toMatch(/setUserAgent|userAgentFallback|sensor_data|solveVisualChallenge/)
    }
  })
})
