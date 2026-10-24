import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { classifyFailure, failoverPolicy, mayRotate, rotationLine } from "../src/engine/proxy-failover"
import { failoverCooldownMs, failProxy, rotateSticky, type StickyPin } from "../src/engine/proxy-hygiene"
import { TaskService } from "../src/engine/task-runner"
import { DEFAULT_SETTINGS, type Notice, type ProxyEndpoint } from "../src/shared/types"
import type { StoreModule, StoreRunContext } from "../src/stores/module"

const SECRET = "pw-never-in-logs"
const proxy = (n: number): ProxyEndpoint => ({ id: `p${n}`, host: `10.0.0.${n}`, port: 8000 + n, username: `user${n}`, password: SECRET })
const pool = [proxy(1), proxy(2), proxy(3)]
const address = { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" as const }

describe("failure classification", () => {
  it("rotates for proxy-attributable failures", () => {
    for (const reason of [
      "Proxy failed. The connection closed before the store answered.",
      "The stock check timed out. The proxy or the store did not answer.",
      "net::ERR_TUNNEL_CONNECTION_FAILED",
      "Proxy authentication required (407)",
      "Store blocked this proxy.",
      "Monitor request returned HTTP 403. Retrying.",
      "Target answered 429 to this proxy",
      "connect ECONNREFUSED 10.0.0.1:8001"
    ]) expect(classifyFailure({ reason }).rotate, reason).toBe(true)
    expect(classifyFailure({ error: new Error("Proxy failed.") }).kind).toBe("connect")
    expect(classifyFailure({ reason: "Target presented a challenge or block.", canHandoff: false }).kind).toBe("challenge")
  })

  it("never rotates for card, stock, login or form failures", () => {
    for (const reason of [
      "Your card was declined.",
      "payment_declined",
      "Out of stock for shipping (OUT_OF_STOCK).",
      "Target rejected the password.",
      "Target could not find that account.",
      "Enter a Target TCIN or a product URL that contains /A-########.",
      "Choose a Target account.",
      "The price is above this checkout's max of $50.00.",
      "The verification code did not arrive"
    ]) expect(classifyFailure({ reason }).rotate, reason).toBe(false)
    // A challenge that a person can still be asked to clear is not a reason to rotate.
    expect(classifyFailure({ reason: "Target presented a challenge or block.", canHandoff: true }).rotate).toBe(false)
  })
})

describe("cooldown and failover order", () => {
  it("escalates the cooldown 5, 10, 20, then 30 minutes and a good response clears it", () => {
    expect([1, 2, 3, 4, 9].map((n) => failoverCooldownMs(n) / 60_000)).toEqual([5, 10, 20, 30, 30])
    let scores = failProxy([], "p1", "connect", 0).scores
    expect(scores[0].benchedUntil).toBe(5 * 60_000)
    scores = failProxy(scores, "p1", "connect", 6 * 60_000).scores
    expect(scores[0].failures).toBe(2)
    expect(scores[0].benchedUntil).toBe(6 * 60_000 + 10 * 60_000)
  })

  it("picks the next healthy proxy in group order, skips resting and reserved ones, and reports exhaustion", () => {
    let scores = failProxy([], "p1", "timeout", 0).scores
    const pins: StickyPin[] = [{ accountId: "acct", groupId: "g", proxyId: "p1", exclusive: true }]
    const first = rotateSticky(pool, pins, scores, "acct", "g", "p1", 1000)
    expect(first.proxy?.id).toBe("p2")
    expect(first.pins.find((pin) => pin.accountId === "acct")?.proxyId).toBe("p2")
    expect(first.index).toBe(2)
    scores = failProxy(scores, "p2", "timeout", 2000).scores
    const second = rotateSticky(pool, first.pins, scores, "acct", "g", "p2", 3000)
    expect(second.proxy?.id).toBe("p3")
    // another account holds p3 exclusively, so nothing healthy is left and the pin does not move
    const taken: StickyPin[] = [...first.pins, { accountId: "other", groupId: "g", proxyId: "p3", exclusive: true }]
    const none = rotateSticky(pool, taken, scores, "acct", "g", "p2", 3000)
    expect(none.exhausted).toBe(true)
    expect(none.pins.find((pin) => pin.accountId === "acct")?.proxyId).toBe("p2")
    // after the cooldown the first proxy is healthy again
    const later = rotateSticky(pool, taken, scores, "acct", "g", "p2", 6 * 60_000 + 10)
    expect(later.proxy?.id).toBe("p1")
  })

  it("has a policy that follows Settings unless the task overrides it", () => {
    expect(failoverPolicy({}, DEFAULT_SETTINGS)).toEqual({ enabled: true, maxRotations: 3 })
    expect(failoverPolicy({ rotateProxy: false, maxRotations: 7 }, DEFAULT_SETTINGS)).toEqual({ enabled: false, maxRotations: 7 })
    expect(failoverPolicy({}, { ...DEFAULT_SETTINGS, rotateProxyOnFailure: false })).toMatchObject({ enabled: false })
    const verdict = classifyFailure({ reason: "Proxy failed." })
    const policy = failoverPolicy({}, DEFAULT_SETTINGS)
    expect(mayRotate({ verdict, policy, rotations: 0, orderSent: false, hasProxy: true }).ok).toBe(true)
    expect(mayRotate({ verdict, policy, rotations: 3, orderSent: false, hasProxy: true })).toEqual({ ok: false, reason: "limit" })
    expect(mayRotate({ verdict, policy, rotations: 0, orderSent: true, hasProxy: true })).toEqual({ ok: false, reason: "order-sent" })
    expect(mayRotate({ verdict, policy, rotations: 0, orderSent: false, hasProxy: false })).toEqual({ ok: false, reason: "no-proxy" })
  })

  it("the log line names host:port and position only", () => {
    const text = rotationLine({ fromLabel: "10.0.0.1:8001", fromIndex: 1, toLabel: "10.0.0.2:8002", toIndex: 2, total: 3, n: 1, max: 3, cooldownMs: 300_000, why: "The proxy connection failed." })
    expect(text).toContain("10.0.0.1:8001 (1 of 3) → 10.0.0.2:8002 (2 of 3)")
    expect(text).not.toContain(SECRET)
  })
})

function world(proxyCount = 3, taskPatch: Record<string, unknown> = {}, settingsPatch: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-failover-"))
  const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
  db.load()
  db.saveSettings({ ...db.getSettings(), ...settingsPatch })
  const group = db.saveProxyGroup({
    name: "Pool",
    text: pool.slice(0, proxyCount).map((item) => `${item.host}:${item.port}:${item.username}:${SECRET}`).join("\n"),
    network: "residential"
  })
  const profile = db.saveProfile({ name: "Home", email: "ada@example.com", phone: "2125550100", shipping: address, billing: address, cardName: "Ada Lovelace", cardNumber: "4242424242424242", expMonth: "12", expYear: "2030", cvv: "123", cardAction: "replace" })
  const account = db.saveAccount({ store: "target", label: "Main", username: "ada@example.com", password: "", passwordAction: "clear", session: "accessToken=t; visitorId=v", sessionAction: "replace", proxyGroupId: group.id })
  const task = db.saveTask({ store: "target", sku: "88897904", quantity: 1, profileId: profile.id, accountId: account.id, proxyGroupId: group.id, confirmPurchase: true, overrides: { retryDelayMs: 250 }, ...taskPatch } as never)
  return { db, group, account, task }
}

function service(db: Database, run: (ctx: StoreRunContext, attempt: number) => ReturnType<StoreModule["run"]>, notices: Notice[] = [], http?: { request: (input: { url: string }) => Promise<{ status: number; body: string; headers: Record<string, string> }> }) {
  let attempt = 0
  const module: StoreModule = { id: "target", displayName: "Target", skuHint: "TCIN", implemented: true, run: (ctx) => run(ctx, ++attempt) }
  return new TaskService(db, new Map([["target", module]]), () => undefined, async (notice) => {
    notices.push(notice)
    return true
  }, (http ?? { request: async () => ({ status: 200, body: "{}", headers: {} }) }) as never)
}

const allText = (db: Database, id: string) => JSON.stringify(db.getTask(id))

describe("task proxy failover", () => {
  it("rotates after a proxy failure, re-pins the account, retries, and never logs credentials", async () => {
    const { db, account, task } = world()
    const used: (string | undefined)[] = []
    const svc = service(db, async (ctx, attempt) => {
      used.push(ctx.proxy?.id)
      if (attempt === 1) return { outcome: "failed", reason: "Proxy failed. The connection closed before the store answered." }
      return { outcome: "success", orderId: "42", detail: "Order 42" }
    })
    svc.start(task.id)
    await svc.wait(task.id)
    const saved = db.getTask(task.id)
    expect(saved.status).toBe("success")
    expect(used).toHaveLength(2)
    expect(used[0]).not.toBe(used[1])
    const logs = saved.logs.map((entry) => entry.message).join("\n")
    expect(logs).toMatch(/Proxy rotation 1\/3: 10\.0\.0\.\d:80\d\d \(\d of 3\) → 10\.0\.0\.\d:80\d\d \(\d of 3\)/)
    expect(allText(db, task.id)).not.toContain(SECRET)
    expect(allText(db, task.id)).not.toContain("user1")
    const pinned = db.listAccounts().find((item) => item.id === account.id)
    expect(pinned?.stickyProxyId).toBe(used[1])
    const scores = db.proxyScores()
    const failed = scores.find((score) => score.proxyId === used[0])
    expect(failed?.benchedUntil).toBeGreaterThan(Date.now() + 4 * 60_000)
    expect(failed?.failures).toBe(1)
    // a fresh run keeps the new pin, so HTTP and browser windows stay on it
    expect(db.assignProxy(account.id, db.listProxyGroups()[0].id, db.listProxyGroups()[0].proxies).proxy?.id).toBe(used[1])
  })

  it("does not rotate for a declined card or a bad login", async () => {
    for (const reason of ["Your card was declined.", "Target rejected the password.", "Out of stock for shipping (OUT_OF_STOCK)."]) {
      const { db, task } = world()
      let attempts = 0
      const svc = service(db, async () => {
        attempts += 1
        return { outcome: "failed", reason }
      })
      svc.start(task.id)
      await svc.wait(task.id)
      expect(attempts, reason).toBe(1)
      expect(db.getTask(task.id).status).toBe("failed")
      expect(db.proxyScores().every((score) => !score.failures)).toBe(true)
      expect(allText(db, task.id)).not.toContain("Proxy rotation")
    }
  })

  it("never retries a checkout after the place-order request went out", async () => {
    const { db, task } = world()
    let attempts = 0
    const sent: string[] = []
    const svc = service(db, async (ctx) => {
      attempts += 1
      await ctx.http.request({ method: "POST", url: "https://carts.target.com/web_checkouts/v1/checkout", body: "{}" })
      throw new Error("Proxy failed. The connection closed before the store answered.")
    }, [], { request: async (input) => { sent.push(input.url); return { status: 200, body: "{}", headers: {} } } })
    svc.start(task.id)
    await svc.wait(task.id)
    expect(attempts).toBe(1)
    expect(sent).toHaveLength(1)
    expect(db.getTask(task.id).status).toBe("failed")
    expect(allText(db, task.id)).toContain("will not rotate the proxy or retry this checkout")
    expect(db.proxyScores().every((score) => !score.failures)).toBe(true)
  })

  it("rotates in Dry run, where place order is never sent", async () => {
    const { db, task } = world()
    let attempts = 0
    const svc = service(db, async (ctx) => {
      attempts += 1
      await ctx.http.request({ method: "POST", url: "https://carts.target.com/web_checkouts/v1/checkout", body: "{}" }).catch(() => undefined)
      if (attempts === 1) throw new Error("Proxy failed.")
      return { outcome: "tested", detail: "ok" }
    })
    svc.start(task.id, { test: true })
    await svc.wait(task.id)
    expect(attempts).toBe(2)
    expect(db.getTask(task.id).status).toBe("tested")
  })

  it("stops with a clear message and a Proxy blocked notice when no healthy proxy is left", async () => {
    const { db, task } = world(2)
    const notices: Notice[] = []
    let attempts = 0
    const svc = service(db, async () => {
      attempts += 1
      throw new Error("Proxy failed.")
    }, notices)
    svc.start(task.id)
    await svc.wait(task.id)
    const saved = db.getTask(task.id)
    expect(attempts).toBe(2)
    expect(saved.status).toBe("failed")
    expect(saved.detail).toMatch(/No healthy proxy is left in Pool/)
    expect(notices.some((notice) => notice.kind === "blocked" && /No healthy proxy/.test(notice.detail))).toBe(true)
    expect(JSON.stringify(notices)).not.toContain(SECRET)
  })

  it("respects the per-task off switch and the max rotations per run", async () => {
    const off = world(3, { rotateProxy: false })
    let offAttempts = 0
    const a = service(off.db, async () => {
      offAttempts += 1
      return { outcome: "failed", reason: "Proxy failed." }
    })
    a.start(off.task.id)
    await a.wait(off.task.id)
    expect(offAttempts).toBe(1)
    expect(off.db.getTask(off.task.id).rotateProxy).toBe(false)

    const capped = world(3, { maxRotations: 1 })
    let capAttempts = 0
    const b = service(capped.db, async () => {
      capAttempts += 1
      return { outcome: "failed", reason: "Proxy failed." }
    })
    b.start(capped.task.id)
    await b.wait(capped.task.id)
    expect(capAttempts).toBe(2)
    expect(capped.db.getTask(capped.task.id).status).toBe("failed")
    expect(allText(capped.db, capped.task.id)).toContain("rotation limit reached (1 this run)")

    const globalOff = world(3, {}, { rotateProxyOnFailure: false })
    let globalAttempts = 0
    const c = service(globalOff.db, async () => {
      globalAttempts += 1
      return { outcome: "failed", reason: "Proxy failed." }
    })
    c.start(globalOff.task.id)
    await c.wait(globalOff.task.id)
    expect(globalAttempts).toBe(1)
  })

  it("rotates when a store check cannot be handed to a person", async () => {
    const { db, task } = world()
    let attempts = 0
    const svc = service(db, async () => {
      attempts += 1
      if (attempts === 1) return { outcome: "paused", reason: "Target presented a challenge or block. Sign in with your own browser." }
      return { outcome: "success", detail: "ok" }
    })
    svc.start(task.id)
    await svc.wait(task.id)
    expect(attempts).toBe(2)
    expect(db.getTask(task.id).status).toBe("success")
  })

  it("rotates mid-run after the block budget is spent, and later requests use the new proxy", async () => {
    const { db, task, group } = world(3, { overrides: { retryDelayMs: 250, blockBackoffMs: 250, maxRetries: 1 } })
    const first = group.proxies[0].id
    const wire: string[] = []
    const svc = service(db, async (ctx) => {
      for (let step = 0; step < 4; step += 1) await ctx.http.request({ method: "GET", url: "https://redsky.target.com/x", proxy: ctx.proxy })
      return { outcome: "success", detail: "ok" }
    }, [], { request: async (input: { url: string; proxy?: ProxyEndpoint }) => { wire.push(input.proxy?.id ?? "direct"); return { status: input.proxy?.id === first ? 403 : 200, body: "{}", headers: {} } } } as never)
    svc.start(task.id)
    await svc.wait(task.id)
    expect(db.getTask(task.id).status).toBe("success")
    expect(wire[0]).toBe(first)
    expect(wire.at(-1)).not.toBe(first)
    expect(wire.filter((id) => id === first).length).toBeLessThanOrEqual(4)
    expect(allText(db, task.id)).toMatch(/Proxy rotation 1\/3/)
  })
})

describe("settings", () => {
  it("defaults on, with a per-run cap, and the task fields are saved", () => {
    const { db, task } = world(3, { rotateProxy: true, maxRotations: 4 })
    expect(db.getSettings().rotateProxyOnFailure).toBe(true)
    expect(db.getSettings().maxProxyRotations).toBe(3)
    expect(db.getTask(task.id)).toMatchObject({ rotateProxy: true, maxRotations: 4 })
    db.saveSettings({ ...db.getSettings(), rotateProxyOnFailure: false, maxProxyRotations: 99 })
    expect(db.getSettings()).toMatchObject({ rotateProxyOnFailure: false, maxProxyRotations: 10 })
  })
})
