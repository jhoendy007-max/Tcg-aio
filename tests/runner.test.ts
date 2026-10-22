import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { TaskService } from "../src/engine/task-runner"
import type { StoreModule } from "../src/stores/module"
import { createTargetModule } from "../src/stores/target"
import type { Notice } from "../src/shared/types"

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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-run-"))
  const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
  db.load()
  const profile = db.saveProfile({
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
    cardAction: "replace"
  })
  const account = db.saveAccount({
    store: "target",
    label: "Main",
    username: "ada@example.com",
    password: "",
    passwordAction: "clear",
    session: "accessToken=token-1; visitorId=visitor-1",
    sessionAction: "replace"
  })
  const task = db.saveTask({
    store: "target",
    sku: "88897904",
    quantity: 1,
    profileId: profile.id,
    accountId: account.id,
    proxyGroupId: null,
    confirmPurchase: true
  })
  return { db, task }
}

describe("task runner", () => {
  it("records success and notifies", async () => {
    const { db, task } = setup()
    const notices: Notice[] = []
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        ctx.phase("monitoring")
        ctx.log("info", "watching")
        ctx.phase("checking_out")
        return { outcome: "success", orderId: "42", detail: "Order 42" }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async (notice) => {
      notices.push(notice)
      return true
    })
    service.start(task.id)
    await service.wait(task.id)
    const saved = db.getTask(task.id)
    expect(saved.status).toBe("success")
    expect(saved.detail).toBe("Order 42")
    expect(saved.logs.some((line) => line.message.includes("watching"))).toBe(true)
    expect(notices[0]).toMatchObject({ kind: "success", orderId: "42" })
    expect(JSON.stringify(db.listTasks())).not.toContain("4242424242424242")
  })

  it("stops a waiting task", async () => {
    const { db, task } = setup()
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        ctx.phase("monitoring")
        await ctx.sleep(30000)
        return { outcome: "success", detail: "late" }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false)
    service.start(task.id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    service.stop(task.id)
    await service.wait(task.id)
    expect(db.getTask(task.id).status).toBe("stopped")
  })

  it("does not send place order when the daily budget is spent", async () => {
    const { db, task } = setup()
    db.saveSettings({ ...db.getSettings(), dailyBudget: 10, healthReportZone: "UTC" })
    db.recordCheckout({ store: "target", sku: "88897904", product: "ETB", outcome: "success", profileName: "Home", detail: "Order 1", price: 10, accountId: "other", quantity: 1 })
    const urls: string[] = []
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        await ctx.http.request({ method: "POST", url: "https://www.target.com/web_checkouts/v1/checkout", body: "{}" })
        return { outcome: "success", detail: "should not win" }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false, {
      async request(input) {
        urls.push(input.url)
        return { status: 200, body: "{}", headers: {} }
      }
    })
    service.start(task.id)
    await service.wait(task.id)
    expect(db.getTask(task.id).status).toBe("paused")
    expect(urls).toEqual([])
  })

  it("does not send place order when a configured price cap cannot be verified", async () => {
    const { db, task } = setup()
    db.saveTask({
      id: task.id,
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: task.profileId,
      accountId: task.accountId,
      proxyGroupId: null,
      confirmPurchase: true,
      maxPrice: 50
    })
    const urls: string[] = []
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        await ctx.http.request({ method: "POST", url: "https://carts.target.com/web_checkouts/v1/checkout", body: "{}" })
        return { outcome: "success", detail: "should not win" }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false, {
      async request(input) {
        urls.push(input.url)
        return { status: 200, body: "{}", headers: {} }
      }
    })
    service.start(task.id)
    await service.wait(task.id)
    expect(db.getTask(task.id).status).toBe("paused")
    expect(db.getTask(task.id).detail).toMatch(/price could not be verified/i)
    expect(urls).toEqual([])
  })

  it("refuses to start without purchase confirmation", () => {
    const { db, task } = setup()
    db.saveTask({
      id: task.id,
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: task.profileId,
      accountId: task.accountId,
      proxyGroupId: null,
      confirmPurchase: false
    })
    const service = new TaskService(db, new Map(), () => undefined, async () => false)
    expect(() => service.start(task.id)).toThrow(/real shipping order/)
  })

  it("starts a monitor-only task without purchase confirmation", async () => {
    const { db, task } = setup()
    db.saveTask({
      id: task.id,
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: task.profileId,
      accountId: task.accountId,
      proxyGroupId: null,
      confirmPurchase: false,
      monitorOnly: true
    })
    let cart = false
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        expect(ctx.monitorOnly).toBe(true)
        ctx.phase("in_stock")
        ctx.phase("adding_to_cart")
        cart = true
        return { outcome: "stopped", reason: "Stopped" }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false)
    service.start(task.id)
    await service.wait(task.id)
    const saved = db.getTask(task.id)
    expect(saved.status).toBe("stopped")
    expect(saved.detectToCartMs).toBeGreaterThanOrEqual(0)
    expect(cart).toBe(true)
  })

  it("logs each anonymous stock check and turns a client block into a plain failure", async () => {
    const { db } = setup()
    const group = db.saveProxyGroup({ name: "test 1", network: "residential", text: "69.85.83.159:48921:user:pass" })
    const monitor = db.saveTask({
      store: "target",
      sku: "94827540",
      quantity: 1,
      profileId: "",
      accountId: "",
      proxyGroupId: null,
      monitorProxyGroupId: group.id,
      confirmPurchase: false,
      kind: "monitor",
      monitorOnly: true
    })
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        ctx.phase("monitoring")
        await ctx.http.request({
          method: "GET",
          url: "https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1",
          proxy: ctx.proxy
        })
        return { outcome: "success", detail: "should not win" }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false, {
      async request() {
        throw new Error("net::ERR_BLOCKED_BY_CLIENT")
      }
    })
    service.start(monitor.id)
    await service.wait(monitor.id)
    const saved = db.getTask(monitor.id)
    const messages = saved.logs.map((entry) => entry.message)
    expect(messages).toContain("This group has 1 proxy; stores block a single proxy quickly")
    expect(messages).toContain("Opening the stock check through proxy 69.85.83.159:48921.")
    expect(messages).toContain("Checking stock at redsky.target.com through proxy 69.85.83.159:48921.")
    expect(saved.status).toBe("failed")
    expect(saved.detail).toBe("Request blocked inside the app.")
    expect(messages).not.toContain("net::ERR_BLOCKED_BY_CLIENT")
    const webhook = saved.logs.find((entry) => entry.message === "Discord webhook is not set.")
    expect(webhook?.level).toBe("info")
  })

  it("keeps watching when Target blocks the only proxy until the user stops", async () => {
    const { db } = setup()
    const group = db.saveProxyGroup({ name: "one", network: "residential", text: "13.141.190.3:28067" })
    const monitor = db.saveTask({
      store: "target",
      sku: "94827540",
      quantity: 1,
      profileId: "",
      accountId: "",
      proxyGroupId: null,
      monitorProxyGroupId: group.id,
      confirmPurchase: false,
      kind: "monitor",
      monitorOnly: true
    })
    const service = new TaskService(db, new Map([["target", createTargetModule()]]), () => undefined, async () => false, {
      async request(input) {
        const url = new URL(input.url)
        expect(url.searchParams.get("visitor_id")).toMatch(/^[0-9A-F]{32}$/)
        expect(url.searchParams.get("pricing_store_id")).toBeTruthy()
        expect(input.headers?.["x-requested-with"]).toBeUndefined()
        return { status: 435, headers: {}, body: "" }
      }
    })
    service.start(monitor.id)
    const deadline = Date.now() + 8_000
    let sawBlock = false
    while (Date.now() < deadline) {
      const messages = db.getTask(monitor.id).logs.map((entry) => entry.message)
      if (messages.some((message) => message === "Target blocked this proxy (HTTP 435). Add more residential proxies to the group or try another one.")) {
        sawBlock = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    service.stop(monitor.id)
    await service.wait(monitor.id)
    const saved = db.getTask(monitor.id)
    const text = saved.logs.map((entry) => entry.message).join("\n")
    expect(sawBlock).toBe(true)
    expect(text).toContain("This group has 1 proxy; stores block a single proxy quickly")
    expect(text).not.toMatch(/reloading the store session|saved session|embedded browser/i)
    expect(saved.status).toBe("stopped")
  })
})
