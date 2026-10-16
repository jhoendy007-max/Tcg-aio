import { mkdtempSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { AlertService } from "../src/engine/alerts"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import type { HttpClient, HttpRequest } from "../src/engine/http"
import { keywordsAllow } from "../src/engine/keywords"
import { parseListings } from "../src/engine/listings"
import { parseDiscordContent, parseWebhook } from "../src/engine/restock-parse"
import { decideRestock } from "../src/engine/restock-rules"
import { FinalSubmitBlocked, finishTest } from "../src/engine/test-mode"
import { TaskService } from "../src/engine/task-runner"
import { RelayServer } from "../src/phone/relay"
import { PhoneServer, type PhoneHost } from "../src/phone/server"
import { EMPTY_ALERTS, EMPTY_ANALYTICS, EMPTY_KEEPER, EMPTY_UPDATES } from "../src/phone/protocol"
import type { Notice, ProxyEndpoint } from "../src/shared/types"
import type { StoreModule } from "../src/stores/module"

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

const servers: { close: () => Promise<void> }[] = []
afterEach(async () => {
  while (servers.length) await servers.pop()?.close()
})

function http(handler: (input: HttpRequest) => { status: number; body: string }): HttpClient & { urls: string[]; proxies: string[] } {
  const urls: string[] = []
  const proxies: string[] = []
  return {
    urls,
    proxies,
    async request(input) {
      urls.push(input.url)
      proxies.push(input.proxy?.host ?? "")
      const result = handler(input)
      return { status: result.status, headers: {}, body: result.body }
    }
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-alerts-"))
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
    session: "accessToken=token-1",
    sessionAction: "replace"
  })
  return { db, profile, account }
}

describe("restock and keyword alerts", () => {
  it("matches positive keywords and rejects excluded ones", () => {
    expect(keywordsAllow("+elite +trainer +box +pokemon -sleeves", "Pokemon Elite Trainer Box")).toBe(true)
    expect(keywordsAllow("+elite +trainer +box +pokemon -sleeves", "Pokemon Elite Trainer Box sleeves")).toBe(false)
    expect(keywordsAllow("\"elite trainer box\" -sleeves", "Shiny elite trainer box")).toBe(true)
  })

  it("parses the webhook JSON and Discord links for every store", () => {
    const parsed = parseWebhook({
      store: "Target",
      tcin: "88897904",
      name: "Pokemon Elite Trainer Box",
      currentPrice: "$49.99",
      source: "restockr"
    })
    expect("signals" in parsed && parsed.signals[0]).toMatchObject({ store: "target", sku: "88897904", price: 49.99, source: "restockr" })
    const text = [
      "https://www.target.com/p/-/A-88897904",
      "https://www.walmart.com/ip/13816151308",
      "https://www.bestbuy.com/site/sku/6606082",
      "https://www.pokemoncenter.com/product/10-12345",
      "https://www.amazon.com/dp/B0TESTASIN",
      "https://www.crunchyroll.com/store/products/12345678.html",
      "walmart 13816151309 Pokemon ETB $19.99"
    ].join("\n")
    const signals = parseDiscordContent(text)
    expect(signals.map((signal) => `${signal.store}:${signal.sku}`)).toEqual([
      "target:88897904",
      "walmart:13816151308",
      "bestbuy:6606082",
      "pokemon-center:10-12345",
      "amazon:B0TESTASIN",
      "crunchyroll:12345678",
      "walmart:13816151309"
    ])
    expect(signals.at(-1)?.price).toBe(19.99)
  })

  it("enforces cooldown, price, quantity, and test mode", () => {
    const signal = { store: "target" as const, sku: "88897904", title: "Elite Trainer Box", price: 49.99, url: "", quantity: 2, soldBy: "Target", inStock: true, source: "webhook" }
    const rule = {
      id: "r",
      name: "ETB",
      enabled: true,
      store: "target" as const,
      sku: "88897904",
      keywords: "",
      taskId: null,
      profileId: "p",
      accountId: "a",
      proxyGroupId: null,
      quantity: 2,
      maxQuantity: 1,
      maxPrice: 50,
      cooldownSec: 300,
      testMode: false,
      confirmPurchase: true,
      lastFiredAt: 0
    }
    expect(decideRestock({ rule, signal, now: 1_000, globalTestMode: true, task: null })).toMatchObject({ action: "create", quantity: 1, testMode: true })
    expect(decideRestock({ rule, signal: { ...signal, price: 80 }, now: 1_000, globalTestMode: false, task: null }).reason).toMatch(/cap/)
    expect(decideRestock({ rule: { ...rule, lastFiredAt: 900_000 }, signal, now: 1_000_000, globalTestMode: false, task: null }).reason).toMatch(/Cooldown/)
    expect(decideRestock({
      rule: { ...rule, taskId: "t", maxQuantity: 1, testMode: true },
      signal,
      now: 1_000,
      globalTestMode: false,
      task: { id: "t", store: "target", quantity: 4, confirmPurchase: true, testMode: false }
    }).reason).toMatch(/cap/)
  })

  it("auto-starts a test task and never sends place order", async () => {
    const { db, profile, account } = setup()
    const seen: string[] = []
    const fake = http(() => ({ status: 200, body: "" }))
    fake.request = async (input) => {
      seen.push(input.url)
      return { status: 200, headers: {}, body: "" }
    }
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        await ctx.http.request({ method: "POST", url: "https://carts.target.com/checkout_payments/v1/payment_instructions", body: "{}" })
        try {
          await ctx.http.request({ method: "POST", url: "https://carts.target.com/web_checkouts/v1/checkout", body: "{}" })
        } catch (err) {
          if (err instanceof FinalSubmitBlocked) return finishTest(ctx)
          throw err
        }
        return { outcome: "success", detail: "placed" }
      }
    }
    const runner = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false, fake)
    const alerts = new AlertService(db, () => runner, async () => false, fake)
    db.saveRestockRule({
      name: "ETB",
      enabled: true,
      store: "target",
      sku: "88897904",
      keywords: "",
      taskId: null,
      profileId: profile.id,
      accountId: account.id,
      proxyGroupId: null,
      quantity: 1,
      maxQuantity: 1,
      maxPrice: 60,
      cooldownSec: 60,
      testMode: true,
      confirmPurchase: false
    })
    const hits = await alerts.ingest({
      store: "target",
      sku: "88897904",
      title: "Pokemon Elite Trainer Box",
      price: 49.99,
      url: "",
      quantity: 1,
      soldBy: "Target",
      inStock: true,
      source: "webhook"
    }, "webhook")
    expect(hits[0]?.action).toBe("create")
    const created = db.listTasks().find((task) => task.sku === "88897904")
    expect(created?.testMode).toBe(true)
    if (created) await runner.wait(created.id)
    expect(db.getTask(created!.id).status).toBe("tested")
    expect(seen.some((url) => url.includes("/web_checkouts/v1/checkout"))).toBe(false)
    expect(seen.some((url) => url.includes("payment_instructions"))).toBe(true)
  })

  it("reads listings, pauses on a block, and rotates proxies", async () => {
    const { db, profile, account } = setup()
    const group = db.saveProxyGroup({ name: "Pool", text: "10.0.0.1:8000:u:p\n10.0.0.2:8000:u:p" })
    const calls: ProxyEndpoint[] = []
    let blocked = true
    const fake = http(() => ({ status: blocked ? 403 : 200, body: blocked ? "captcha" : JSON.stringify({
      data: { search: { products: [{ tcin: "88897904", item: { product_description: { title: "Pokemon Elite Trainer Box" } }, price: { current_retail: 49.99 } }] } }
    }) }))
    const original = fake.request.bind(fake)
    fake.request = async (input) => {
      if (input.proxy) calls.push(input.proxy)
      return original(input)
    }
    const notices: Notice[] = []
    const alerts = new AlertService(db, () => null, async (notice) => {
      notices.push(notice)
      return true
    }, fake)
    const watch = db.saveWatch({
      name: "ETB",
      enabled: true,
      store: "target",
      keywords: "+elite +trainer +pokemon -sleeves",
      maxPrice: 60,
      soldByRetailer: true,
      proxyGroupId: group.id,
      profileId: profile.id,
      accountId: account.id,
      quantity: 1,
      maxQuantity: 1,
      autoStart: false,
      testMode: true,
      confirmPurchase: false
    })
    await alerts.pollWatchOnce(watch.id)
    expect(db.listWatches()[0]?.status).toBe("blocked")
    expect(notices[0]?.kind).toBe("paused")
    blocked = false
    db.resumeWatch(watch.id)
    await alerts.pollWatchOnce(watch.id)
    expect(calls.map((proxy) => proxy.host)).toEqual(["10.0.0.1", "10.0.0.2"])
    expect(db.listWatches()[0]?.status).toBe("watching")
    expect(notices.some((notice) => notice.kind === "alert")).toBe(true)
    expect(db.listWatches()[0]?.seenSkus).toContain("88897904")
  })

  it("ignores marketplace and over-cap listings", () => {
    const listings = parseListings("amazon", JSON.stringify({
      products: [
        { asin: "B0RETAILER", title: "Pokemon Elite Trainer Box", price: 49.99, amazonRetail: true },
        { asin: "B0MARKET01", title: "Pokemon Elite Trainer Box", price: 40, amazonRetail: false },
        { asin: "B0TOOEXPEN", title: "Pokemon Elite Trainer Box", price: 90, amazonRetail: true }
      ]
    }))
    expect(listings.find((item) => item.sku === "B0RETAILER")?.retailer).toBe(true)
    expect(listings.find((item) => item.sku === "B0MARKET01")?.retailer).toBe(false)
    expect(listings.find((item) => item.sku === "B0TOOEXPEN")?.price).toBe(90)
  })

  it("rejects a webhook without the token and accepts the documented JSON", async () => {
    const { db, profile, account } = setup()
    const alerts = new AlertService(db, () => ({ start() { return undefined } } as unknown as TaskService), async () => false, http(() => ({ status: 200, body: "" })))
    db.saveRestockRule({
      name: "ETB",
      enabled: true,
      store: "target",
      sku: "88897904",
      keywords: "+elite",
      taskId: null,
      profileId: profile.id,
      accountId: account.id,
      proxyGroupId: null,
      quantity: 1,
      maxQuantity: 1,
      maxPrice: null,
      cooldownSec: 0,
      testMode: true,
      confirmPurchase: false
    })
    const denied = await alerts.ingestHttp(undefined, undefined, "{}")
    expect(denied.status).toBe(401)
    const token = db.rotateRestockToken()
    const accepted = await alerts.ingestHttp(`Bearer ${token}`, undefined, JSON.stringify({
      store: "target",
      sku: "88897904",
      title: "Pokemon Elite Trainer Box",
      price: 49.99,
      inStock: true,
      source: "restockr"
    }))
    expect(accepted.status).toBe(200)
    expect(accepted.body).toContain("\"action\":\"create\"")
  })

  it("arms the Discord watcher without replaying old messages", async () => {
    const { db } = setup()
    db.saveDiscordWatch({ channelId: "123456789012345678", enabled: true, token: "bot-token-value-that-is-long", tokenAction: "replace" })
    let calls = 0
    const fake = http(() => {
      calls += 1
      if (calls === 1) return { status: 200, body: JSON.stringify([{ id: "10", content: "https://www.target.com/p/-/A-88897904" }]) }
      return { status: 200, body: JSON.stringify([{ id: "11", content: "target 88897905 Elite Trainer Box $40" }, { id: "10", content: "old" }]) }
    })
    const alerts = new AlertService(db, () => null, async () => false, fake)
    await alerts.pollDiscordOnce()
    expect(db.listAlertLog().some((entry) => entry.result.includes("ignored"))).toBe(true)
    expect(db.listAlertLog().some((entry) => entry.sku === "88897904")).toBe(false)
    await alerts.pollDiscordOnce()
    expect(db.listAlertLog().some((entry) => entry.sku === "88897905")).toBe(true)
    expect(fake.urls[0]).toContain("/channels/123456789012345678/messages")
  })

  it("serves the local webhook and forwards one through the relay", async () => {
    const host: PhoneHost = {
      pcId: "pc-1",
      pcName: "Test",
      relayUrl: () => "",
      snapshot: () => ({ pcName: "Test", testMode: false, clearCartAfterTest: false, tasks: [], profiles: [], accounts: [], proxyGroups: [], stores: [], alerts: EMPTY_ALERTS, schedules: [], analytics: EMPTY_ANALYTICS, updates: EMPTY_UPDATES, keeper: EMPTY_KEEPER }),
      saveTask: () => { throw new Error("no") },
      deleteTask: () => undefined,
      start: () => undefined,
      checkHealth: async () => [],
      stop: () => undefined,
      startAll: () => ({ started: [], errors: [] }),
      stopAll: () => undefined,
      devices: () => [],
      deviceTokens: () => [],
      saveDevice: () => undefined,
      revokeDevice: () => undefined,
      touchDevice: () => undefined
    }
    const phone = new PhoneServer(host, { bindHost: "127.0.0.1", advertiseHost: "127.0.0.1", port: 0 })
    servers.push({ close: () => phone.stop() })
    let seen = ""
    phone.setRestock(async (authorization, _token, body) => {
      seen = `${authorization}:${body}`
      return { status: 202, body: JSON.stringify({ ok: true }) }
    })
    await phone.start()
    const local = await post(`http://127.0.0.1:${phone.port}/v1/restock`, { authorization: "Bearer secret" }, "{\"store\":\"target\"}")
    expect(local.status).toBe(202)
    expect(seen).toContain("Bearer secret")

    const relay = new RelayServer(0, "127.0.0.1")
    servers.push({ close: () => relay.close() })
    await relay.start()
    const socket = new WebSocket(relay.url)
    await new Promise<void>((resolve) => socket.once("open", () => resolve()))
    socket.send(JSON.stringify({ op: "join", role: "pc", pc: "pc-1" }))
    const joined = await onceMessage(socket)
    expect(JSON.parse(joined).op).toBe("joined")
    const forwarded = onceMessage(socket)
    const response = post(`http://127.0.0.1:${relay.port}/v1/restock/pc-1`, { authorization: "Bearer secret" }, "{\"sku\":\"1\"}")
    const inbound = JSON.parse(await forwarded) as { op: string; id: string; body: string }
    expect(inbound.op).toBe("restock")
    expect(inbound.body).toContain("\"sku\":\"1\"")
    socket.send(JSON.stringify({ op: "restock-result", id: inbound.id, status: 200, body: "{\"ok\":true,\"via\":\"relay\"}" }))
    const relayed = await response
    expect(relayed.status).toBe(200)
    expect(relayed.body).toContain("relay")
    socket.close()
  })
})

function post(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: { ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk) => chunks.push(chunk))
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }))
    })
    req.on("error", reject)
    req.end(body)
  })
}

function onceMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => socket.once("message", (data) => resolve(data.toString())))
}
