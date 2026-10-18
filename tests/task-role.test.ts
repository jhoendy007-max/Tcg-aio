import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AlertService } from "../src/engine/alerts"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { TaskService } from "../src/engine/task-runner"
import { parseTaskDraft } from "../src/phone/protocol"
import { paceAddToCart, type StoreRunContext } from "../src/stores/module"
import { checkoutsToStart, inActiveHours, keywordMatch, normalizeRole, restockCheckouts, roleFields, structuralChange, taskText, triggerDecision } from "../src/shared/task-role"
import type { RestockSignal } from "../src/engine/restock-parse"
import type { AccountInput, ProfileInput, PublicTask, TaskInput } from "../src/shared/types"

const address = {
  firstName: "Ada",
  lastName: "Lovelace",
  line1: "1 Main St",
  line2: "",
  city: "New York",
  state: "NY",
  zip: "10001",
  country: "US" as const
}

function profile(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    name: "Home",
    email: "ada@example.com",
    phone: "2125550100",
    shipping: address,
    billing: address,
    cardName: "Ada Lovelace",
    cardNumber: "4242424242424242",
    expMonth: "12",
    expYear: "2030",
    cvv: "123",
    cardAction: "replace",
    ...overrides
  }
}

function account(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    store: "target",
    label: "Main",
    username: "ada@example.com",
    password: "",
    passwordAction: "clear",
    session: "",
    sessionAction: "clear",
    ...overrides
  }
}

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-roles-"))
  const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
  db.load()
  const savedProfile = db.saveProfile(profile())
  const savedAccount = db.saveAccount(account())
  return { db, profileId: savedProfile.id, accountId: savedAccount.id }
}

function checkoutInput(ids: { profileId: string; accountId: string }, sku: string, extra: Partial<TaskInput> = {}): TaskInput {
  return {
    store: "target",
    sku,
    quantity: 1,
    profileId: ids.profileId,
    accountId: ids.accountId,
    proxyGroupId: null,
    confirmPurchase: false,
    testMode: true,
    kind: "checkout",
    startMode: "builtin",
    ...extra
  }
}

function asInput(task: PublicTask): TaskInput {
  return {
    id: task.id,
    store: task.store,
    sku: task.sku,
    quantity: task.quantity,
    profileId: task.profileId,
    accountId: task.accountId,
    proxyGroupId: task.proxyGroupId,
    monitorProxyGroupId: task.monitorProxyGroupId,
    confirmPurchase: task.confirmPurchase,
    testMode: task.testMode,
    group: task.group,
    kind: task.kind,
    keywords: task.keywords,
    priceCap: task.priceCap,
    webhook: task.webhook,
    activeHours: task.activeHours,
    linkedCheckoutIds: task.linkedCheckoutIds,
    checkoutDelayMs: task.checkoutDelayMs,
    maxPrice: task.maxPrice,
    startMode: task.startMode,
    linkedMonitorId: task.linkedMonitorId,
    jitterPct: task.jitterPct,
    overrides: task.overrides
  }
}

describe("task roles", () => {
  it("keeps a legacy monitor-only task as a monitor and ignores a bad stored price", () => {
    expect(normalizeRole({ monitorOnly: true }).kind).toBe("monitor")
    expect(normalizeRole({ monitorOnly: true }).startMode).toBe("manual")
    expect(normalizeRole({ priceCap: "nope" as unknown as number }).priceCap).toBeNull()
    expect(normalizeRole(undefined).kind).toBe("checkout")
    expect(normalizeRole(undefined).startMode).toBe("builtin")
    expect(taskText("es", "checkout")).toBe("Compra")
  })

  it("gates a monitor on hours, keywords, price, and seller", () => {
    const morning = Date.parse("2026-06-15T13:15:00.000Z")
    const later = Date.parse("2026-06-15T13:45:00.000Z")
    expect(inActiveHours("09:00-09:30", morning)).toBe(true)
    expect(inActiveHours("09:00-09:30", later)).toBe(false)
    expect(inActiveHours("22:00-06:00", Date.parse("2026-06-15T03:30:00.000Z"))).toBe(true)
    expect(inActiveHours("22:00-06:00", Date.parse("2026-06-15T14:00:00.000Z"))).toBe(false)
    expect(inActiveHours("")).toBe(true)
    expect(keywordMatch("elite trainer", "Elite Trainer Box")).toBe(true)
    expect(keywordMatch("elite trainer", "")).toBe(true)
    expect(triggerDecision({
      keywords: "elite trainer",
      priceCap: 40,
      activeHours: "09:00-09:30",
      soldBy: "retailer",
      title: "Elite Trainer Box",
      price: 29.99,
      soldByRetailer: true,
      now: morning
    }).ok).toBe(true)
    expect(triggerDecision({
      keywords: "elite trainer",
      priceCap: 40,
      activeHours: "",
      title: "Booster bundle",
      price: 10,
      soldByRetailer: true
    }).reason).toMatch(/keywords/)
    expect(triggerDecision({
      keywords: "",
      priceCap: 40,
      activeHours: "",
      title: "Elite Trainer Box",
      price: 50,
      soldByRetailer: true
    }).reason).toMatch(/cap/)
    expect(triggerDecision({
      keywords: "",
      priceCap: null,
      activeHours: "",
      soldBy: "retailer",
      title: "Elite Trainer Box",
      price: 20,
      soldByRetailer: false
    }).reason).toMatch(/retailer/)
  })

  it("lets one monitor start many linked checkouts and matches restock by sku or keywords", () => {
    const monitor = { id: "m", store: "target" as const, linkedCheckoutIds: ["a", "b"] }
    const tasks = [
      { id: "a", store: "target", sku: "111", kind: "checkout", startMode: "monitor", linkedMonitorId: "m", status: "idle", keywords: "", maxPrice: 30 },
      { id: "b", store: "target", sku: "222", kind: "checkout", startMode: "builtin", linkedMonitorId: null, status: "idle" },
      { id: "c", store: "target", sku: "333", kind: "checkout", startMode: "monitor", linkedMonitorId: "m", status: "monitoring" },
      { id: "d", store: "walmart", sku: "111", kind: "checkout", startMode: "restock", status: "idle", maxPrice: null }
    ] as PublicTask[]
    expect(checkoutsToStart(monitor, tasks, (status) => status === "monitoring").map((task) => task.id)).toEqual(["a"])
    const signal = { store: "target" as const, sku: "999", title: "Elite Trainer Box", price: 20 }
    const restock = [
      { id: "r1", store: "target", sku: "999", kind: "checkout", startMode: "restock", status: "idle", maxPrice: 25, keywords: "" },
      { id: "r2", store: "target", sku: "other", kind: "checkout", startMode: "restock", status: "idle", maxPrice: 25, keywords: "elite trainer" },
      { id: "r3", store: "target", sku: "999", kind: "checkout", startMode: "restock", status: "idle", maxPrice: 10, keywords: "" },
      { id: "r4", store: "target", sku: "else", kind: "checkout", startMode: "restock", status: "idle", maxPrice: null, keywords: "" }
    ] as PublicTask[]
    expect(restockCheckouts(restock, signal, () => false).map((task) => task.id)).toEqual(["r1", "r2"])
  })

  it("saves a monitor without a profile, links checkouts, and live-edits the cap", () => {
    const { db, profileId, accountId } = openDb()
    const first = db.saveTask(checkoutInput({ profileId, accountId }, "111", { startMode: "manual" }))
    const second = db.saveTask(checkoutInput({ profileId, accountId }, "222", { startMode: "restock" }))
    const monitor = db.saveTask({
      store: "target",
      sku: "",
      quantity: 1,
      profileId: "",
      accountId: "",
      proxyGroupId: null,
      confirmPurchase: true,
      kind: "monitor",
      keywords: "elite trainer",
      priceCap: 50,
      activeHours: "09:00-21:00",
      linkedCheckoutIds: [first.id, second.id],
      webhook: "https://discord.com/api/webhooks/123/abc"
    })
    expect(monitor.kind).toBe("monitor")
    expect(monitor.profileId).toBe("")
    expect(monitor.accountId).toBe("")
    expect(monitor.confirmPurchase).toBe(false)
    expect(monitor.monitorOnly).toBe(true)
    expect(monitor.proxyGroupId).toBeNull()
    expect(db.getTask(first.id).startMode).toBe("monitor")
    expect(db.getTask(first.id).linkedMonitorId).toBe(monitor.id)
    expect(db.getTask(second.id).startMode).toBe("restock")
    expect(db.getTask(second.id).linkedMonitorId).toBe(monitor.id)
    expect(() => db.saveTask(checkoutInput({ profileId, accountId: "" }, "1"))).toThrow(/Account/)
    expect(() => db.saveTask({ ...checkoutInput({ profileId, accountId }, "1"), webhook: "https://example.com/hook" })).toThrow(/webhooks/)
    expect(() => db.saveTask({ ...asInput(monitor), activeHours: "morning" })).toThrow(/09:00-09:30/)

    db.patchTask(monitor.id, { status: "monitoring" })
    const edited = db.saveTask({ ...asInput(db.getTask(monitor.id)), priceCap: 40, keywords: "elite" })
    expect(edited.status).toBe("monitoring")
    expect(edited.priceCap).toBe(40)
    expect(edited.keywords).toBe("elite")
    expect(() => db.saveTask({ ...asInput(db.getTask(monitor.id)), sku: "999" })).toThrow(/Stop the task/)
    expect(structuralChange(db.getTask(first.id), { ...asInput(db.getTask(first.id)), store: "walmart" })).toMatch(/store/)

    const copy = db.duplicateTasks([monitor.id])[0]
    expect(copy?.kind).toBe("monitor")
    expect(copy?.id).not.toBe(monitor.id)
    expect(copy?.status).toBe("idle")
    expect(copy?.keywords).toBe("elite")

    db.patchTask(first.id, { status: "monitoring" })
    const bulk = db.bulkEdit({ ids: [first.id], group: "wave", maxPrice: 30, quantity: 2, keywords: "etb" })
    expect(bulk.updated).toContain(first.id)
    expect(bulk.errors[0]?.error).toMatch(/Stop the task/)
    expect(db.getTask(first.id).group).toBe("wave")
    expect(db.getTask(first.id).maxPrice).toBe(30)
    expect(db.getTask(first.id).keywords).toBe("etb")
    expect(db.getTask(first.id).quantity).toBe(1)
    expect(db.getTask(first.id).status).toBe("monitoring")
  })

  it("starts linked and restock checkouts, and skips tasks that wait for a trigger", async () => {
    const { db, profileId, accountId } = openDb()
    const linked = db.saveTask(checkoutInput({ profileId, accountId }, "111", { confirmPurchase: true, testMode: false }))
    const waiting = db.saveTask(checkoutInput({ profileId, accountId }, "222", { startMode: "restock", confirmPurchase: true, testMode: false }))
    const own = db.saveTask(checkoutInput({ profileId, accountId }, "333", { startMode: "builtin", confirmPurchase: true, testMode: false }))
    const monitor = db.saveTask({
      store: "target",
      sku: "444",
      quantity: 1,
      profileId: "",
      accountId: "",
      proxyGroupId: null,
      confirmPurchase: false,
      kind: "monitor",
      linkedCheckoutIds: [linked.id]
    })
    const ran: string[] = []
    const service = new TaskService(db, new Map([["target", {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        ran.push(ctx.task.id)
        if (ctx.monitorOnly) {
          ctx.observe?.({
            inStock: true,
            price: 20,
            offerId: "o",
            soldByRetailer: true,
            purchasable: true,
            title: "Elite Trainer Box"
          })
        }
        return { outcome: "stopped", reason: "Stopped" }
      }
    }]]), () => undefined, async () => false)
    const all = service.startAll()
    await service.wait(monitor.id)
    await service.wait(own.id)
    await service.wait(linked.id)
    expect(all.started.sort()).toEqual([monitor.id, own.id].sort())
    expect(ran).toContain(linked.id)
    expect(ran).not.toContain(waiting.id)

    const started: string[] = []
    const alerts = new AlertService(db, () => ({ start: (id: string) => { started.push(id) }, isRunning: () => false }) as unknown as TaskService, async () => false, { async request() { return { status: 200, body: "", headers: {} } } })
    const signal: RestockSignal = { store: "target", sku: "222", title: "Elite Trainer Box", price: 19, url: "", quantity: 1, soldBy: "Target", inStock: true, source: "webhook" }
    const hits = await alerts.ingest(signal, "webhook")
    expect(hits.some((hit) => hit.taskId === waiting.id && hit.action === "start")).toBe(true)
    expect(started).toContain(waiting.id)
  })

  it("waits out a checkout delay before the standard add-to-cart pause", async () => {
    const slept: number[] = []
    await paceAddToCart({
      checkoutDelayMs: 40,
      module: { atcMode: "standard", retryDelayMs: 15 },
      log: () => undefined,
      sleep: async (ms: number) => { slept.push(ms) }
    } as unknown as StoreRunContext)
    expect(slept).toEqual([40, 15])
  })

  it("saves a monitor and a linked checkout, then lists each role", () => {
    const { db, profileId, accountId } = openDb()
    const monitor = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: "",
      accountId: "",
      proxyGroupId: null,
      confirmPurchase: false,
      kind: "monitor",
      overrides: { monitorDelayMs: 2500 }
    })
    const checkout = db.saveTask(checkoutInput({ profileId, accountId }, "94724620", {
      startMode: "monitor",
      linkedMonitorId: monitor.id,
      quantity: 2,
      maxPrice: 40
    }))
    expect(monitor.kind).toBe("monitor")
    expect(monitor.overrides?.monitorDelayMs).toBe(2500)
    expect(monitor.profileId).toBe("")
    expect(checkout.kind).toBe("checkout")
    expect(checkout.startMode).toBe("monitor")
    expect(checkout.linkedMonitorId).toBe(monitor.id)
    expect(checkout.quantity).toBe(2)
    expect(checkout.maxPrice).toBe(40)
    expect(checkout.profileId).toBe(profileId)
    expect(checkout.accountId).toBe(accountId)
    const listed = db.listTasks()
    expect(listed.filter((task) => task.kind === "monitor").map((task) => task.id)).toEqual([monitor.id])
    expect(listed.filter((task) => task.kind === "checkout").map((task) => task.id)).toContain(checkout.id)
    expect(checkoutsToStart(monitor, listed, () => false).map((task) => task.id)).toEqual([checkout.id])
    expect(roleFields("monitor")).toMatchObject({ interval: true, sku: true, profile: false, account: false, quantity: false, linkMonitor: false, linkCheckouts: true })
    expect(roleFields("checkout", "builtin")).toMatchObject({ interval: false, profile: true, account: true, quantity: true, maxPrice: true, linkMonitor: false, startMode: true })
    expect(roleFields("checkout", "restock").linkMonitor).toBe(false)
    expect(roleFields("checkout", "monitor").linkMonitor).toBe(true)
    expect(taskText("en", "roleTitle")).toMatch(/task do/)
    expect(taskText("es", "roleBadgeCheckout")).toBe("COMPRA")
  })

  it("accepts a monitor draft from the phone without a profile", () => {
    const draft = parseTaskDraft({ store: "target", sku: "", quantity: 1, kind: "monitor", keywords: "etb", priceCap: 25 })
    expect(draft.kind).toBe("monitor")
    expect(draft.profileId).toBe("")
    expect(draft.keywords).toBe("etb")
    expect(() => parseTaskDraft({ store: "target", sku: "1", quantity: 1, kind: "checkout" })).toThrow(/profile/)
  })
})
