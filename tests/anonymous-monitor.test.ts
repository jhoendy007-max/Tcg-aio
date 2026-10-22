import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { accountsToWarm } from "../src/engine/session-care"
import { draftFromPhoneTask } from "../src/phone/task-draft"
import { resolveRoleDefaults } from "../src/shared/store-defaults"
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/types"
import { createTargetModule } from "../src/stores/target"
import type { StoreRunContext } from "../src/stores/module"

describe("anonymous monitors", () => {
  it("ignores an account saved on an older monitor and still deletes that account", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-monitor-account-"))
    const file = join(dir, "tcgaio.json")
    const cipher = createAesCipher(dir)
    const db = new Database(file, cipher)
    db.load()
    const account = db.saveAccount({
      store: "target",
      label: "Main",
      username: "ada@example.com",
      password: "secret",
      passwordAction: "replace",
      session: "",
      sessionAction: "keep"
    })
    const raw = JSON.parse(readFileSync(file, "utf8")) as { tasks: unknown[] }
    raw.tasks.push({
      id: "mon-1",
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: "profile-old",
      accountId: account.id,
      proxyGroupId: "pool-old",
      kind: "monitor",
      monitorOnly: true,
      status: "idle",
      detail: "",
      logs: [],
      createdAt: 1
    })
    writeFileSync(file, JSON.stringify(raw))
    const again = new Database(file, cipher)
    again.load()
    const task = again.listTasks().find((item) => item.id === "mon-1")
    expect(task?.accountId).toBe("")
    expect(task?.profileId).toBe("")
    expect(task?.proxyGroupId).toBeNull()
    expect(task?.monitorProxyGroupId).toBe("pool-old")
    expect(() => again.deleteAccount(account.id)).not.toThrow()
  })

  it("does not warm or enable account warm-up for a monitor", () => {
    expect(accountsToWarm({ id: "mon", accountId: "acct", kind: "monitor", monitorOnly: true, linkedCheckoutIds: ["co"] }, [{ id: "co", accountId: "acct" }], [{ id: "acct", lastWarmAt: null }], 1_000, 30)).toEqual([])
    const resolved = resolveRoleDefaults("target", "monitor", { target: { monitor: { warmOnStart: true } } })
    expect(resolved.warmOnStart).toEqual({ value: false, source: "builtin" })
    expect(draftFromPhoneTask({ id: "mon", store: "target", sku: "1", accountId: "acct", profileId: "pro", kind: "monitor", monitorOnly: true, quantity: 1, status: "idle", detail: "", logs: [], createdAt: 1, storeName: "Target", profileName: "", accountLabel: "", proxyGroupId: null, proxyGroupName: null, confirmPurchase: false, testMode: false }).accountId).toBe("")
  })

  it("checks Target stock without a session when the task is a monitor", async () => {
    const headers: string[] = []
    const controller = new AbortController()
    const result = await createTargetModule().run(monitorCtx(async (input) => {
      headers.push(JSON.stringify(input.headers ?? {}))
      controller.abort()
      return { status: 200, headers: {}, body: "{\"data\":{}}" }
    }, controller.signal))
    expect(result.outcome === "paused" ? result.reason : "").not.toMatch(/account|password|session/i)
    expect(headers.length).toBeGreaterThan(0)
    expect(headers.join("\n")).not.toMatch(/token-1|cookie/i)
  })
})

function monitorCtx(request: StoreRunContext["http"]["request"], signal: AbortSignal = AbortSignal.abort()): StoreRunContext {
  return {
    task: { id: "mon", sku: "88897904", quantity: 1, store: "target" },
    profile: {
      id: "",
      name: "Monitor",
      email: "",
      phone: "",
      shipping: { firstName: "", lastName: "", line1: "", line2: "", city: "", state: "", zip: "", country: "US" },
      billing: { firstName: "", lastName: "", line1: "", line2: "", city: "", state: "", zip: "", country: "US" },
      cardName: "",
      last4: "",
      expMonth: "",
      expYear: "",
      card: { number: "", cvv: "", expMonth: "", expYear: "", name: "" }
    },
    account: { id: "acct-old", store: "target", label: "Old", username: "ada", session: { accessToken: "token-1", cookie: "session=1" } },
    settings: { ...DEFAULT_SETTINGS, monitorDelayMs: 1 } as Settings,
    signal,
    http: { request },
    log: () => undefined,
    detail: () => undefined,
    phase: () => undefined,
    sleep: async () => undefined,
    onSession: async () => undefined,
    monitorOnly: true
  }
}
