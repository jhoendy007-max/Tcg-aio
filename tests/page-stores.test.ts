import { describe, expect, it } from "vitest"
import { parseBulkTasks } from "../src/engine/bulk"
import { challengePageUrl, classifyChallenge } from "../src/engine/challenge"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { parseListings } from "../src/engine/listings"
import { parseDiscordContent } from "../src/engine/restock-parse"
import { isFinalSubmit } from "../src/engine/test-mode"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile, type StoreId } from "../src/shared/types"
import { createBarnesNobleModule } from "../src/stores/barnes-noble"
import { createCostcoModule, COSTCO_PAUSE } from "../src/stores/costco"
import { createGameStopModule, GAMESTOP_PAUSE } from "../src/stores/gamestop"
import type { StoreModule, StoreRunContext } from "../src/stores/module"
import { BARNES_NOBLE, COSTCO, GAMESTOP, SAMS, hasAddControl, isPageChallenge, parsePageTarget, readPageOffer } from "../src/stores/page/parse"
import { pageHandoff } from "../src/stores/page/run"
import { createSamsModule } from "../src/stores/sams"

const pan = "4242424242424242"

const profile: FullProfile = {
  id: "p1",
  name: "Home",
  email: "ada@example.com",
  phone: "2125550100",
  shipping: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
  billing: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
  cardName: "Ada Lovelace",
  last4: "4242",
  expMonth: "12",
  expYear: "2030",
  card: { name: "Ada Lovelace", number: pan, cvv: "123", expMonth: "12", expYear: "2030" }
}

function account(store: StoreId, session = true): FullAccount {
  return {
    id: "a1",
    store,
    label: "Main",
    username: "ada@example.com",
    session: session ? { accessToken: "session", cookie: "sid=signed-in" } : undefined
  }
}

function productPage(name: string, availability: string, add: "on" | "off" | "disabled" = "on"): string {
  const button = add === "off"
    ? "<p>Unavailable</p>"
    : add === "disabled"
      ? `<button disabled>Add to Cart</button>`
      : `<button type="submit">Add to Cart</button>`
  return `<!doctype html><html><head><script type="application/ld+json">{"@type":"Product","name":"${name}","offers":{"@type":"Offer","price":"49.99","availability":"${availability}"}}</script><meta property="og:image" content="https://cdn.example/p.jpg"></head><body>${button}</body></html>`
}

const challengeHtml = "<html><head><title>Attention Required</title></head><body>Just a moment... verifying your connection</body></html>"
const loginHtml = `<html><body><h1>Sign in</h1><form><input type="password" name="password"></form></body></html>`

function json(status: number, body: string): HttpResponse {
  return { status, headers: {}, body }
}

function client(handler: (req: HttpRequest) => HttpResponse): { http: HttpClient; calls: HttpRequest[] } {
  const calls: HttpRequest[] = []
  return {
    calls,
    http: {
      async request(input) {
        calls.push(input)
        return handler(input)
      }
    }
  }
}

function runCtx(store: StoreId, sku: string, http: HttpClient, overrides: Partial<StoreRunContext> = {}): StoreRunContext {
  return {
    task: { id: "t1", sku, quantity: 1, store },
    profile,
    account: account(store),
    settings: { ...DEFAULT_SETTINGS, monitorDelayMs: 1000 },
    signal: new AbortController().signal,
    http,
    log: () => undefined,
    detail: () => undefined,
    phase: () => undefined,
    sleep: async () => undefined,
    onSession: async () => undefined,
    ...overrides
  }
}

const modules: { id: StoreId; sku: string; module: StoreModule; host: string }[] = [
  { id: "gamestop", sku: "https://www.gamestop.com/toys-games/trading-cards/products/pokemon-day-2026/436435.html", module: createGameStopModule(), host: "www.gamestop.com" },
  { id: "barnes-noble", sku: "https://www.barnesandnoble.com/w/pokemon-handbook/9781465481234", module: createBarnesNobleModule(), host: "www.barnesandnoble.com" },
  { id: "costco", sku: "https://www.costco.com/pokemon.product.100000001.html", module: createCostcoModule(), host: "www.costco.com" },
  { id: "sams", sku: "https://www.samsclub.com/ip/pokemon-etb/980000001", module: createSamsModule(), host: "www.samsclub.com" }
]

describe("product page parsers", () => {
  it("reads a product URL and a bare id", () => {
    expect(parsePageTarget(GAMESTOP, modules[0].sku)?.sku).toBe("436435")
    expect(parsePageTarget(GAMESTOP, "436435")?.url).toBe("https://www.gamestop.com/products/436435.html")
    expect(parsePageTarget(BARNES_NOBLE, "9781465481234")?.url).toBe("https://www.barnesandnoble.com/w/9781465481234")
    expect(parsePageTarget(COSTCO, "https://www.costco.com/.product.100000001.html")?.sku).toBe("100000001")
    expect(parsePageTarget(SAMS, "980000001")?.url).toBe("https://www.samsclub.com/ip/980000001")
    expect(parsePageTarget(GAMESTOP, "https://example.com/products/1/436435.html")).toBeNull()
    expect(parsePageTarget(COSTCO, "https://ecom-api.costco.com/.product.100000001.html")).toBeNull()
    expect(challengePageUrl("gamestop", "436435")).toBe("https://www.gamestop.com/products/436435.html")
    expect(challengePageUrl("costco", modules[2].sku)).toBe("https://www.costco.com/pokemon.product.100000001.html")
  })

  it("treats preorder schema as purchasable and ignores a disabled add button", () => {
    const preorder = readPageOffer(GAMESTOP, productPage("Pokemon Day 2026", "https://schema.org/PreOrder"), "436435")
    expect(preorder.inStock).toBe(true)
    expect(preorder.status).toBe("PRE_ORDER")
    expect(preorder.price).toBe(49.99)
    const hidden = readPageOffer(GAMESTOP, productPage("Pokemon Day 2026", "https://schema.org/OutOfStock", "disabled"), "436435")
    expect(hidden.inStock).toBe(false)
    expect(hasAddControl(productPage("Pokemon Day 2026", "https://schema.org/InStock", "disabled"))).toBe(false)
    expect(isPageChallenge(403, challengeHtml)).toBe(true)
    expect(isPageChallenge(200, productPage("Pokemon Day 2026", "https://schema.org/InStock"))).toBe(false)
  })

  it("does not treat a Costco schema out-of-stock flag as a warehouse count", () => {
    const quiet = readPageOffer(COSTCO, productPage("Elite Trainer Box", "https://schema.org/OutOfStock", "off"), "100000001")
    expect(quiet.inStock).toBe(false)
    expect(quiet.reason).toContain("no add-to-cart control")
    expect(quiet.reason).toContain("Warehouse inventory was not read")
    expect(quiet.reason).not.toMatch(/units|count is|inventory is 0/i)
    const visible = readPageOffer(COSTCO, productPage("Elite Trainer Box", "https://schema.org/OutOfStock", "on"), "100000001")
    expect(visible.inStock).toBe(true)
    expect(visible.status).toBe("IN_STOCK")
  })

  it("reads a product link from a search page", () => {
    const html = `<a href="/toys-games/trading-cards/products/pokemon-day-2026/436435.html">Pokemon Day</a>`
    const listings = parseListings("gamestop", html)
    expect(listings.map((item) => item.sku)).toEqual(["436435"])
    expect(listings[0]?.retailer).toBe(true)
    expect(listings[0]?.url).toContain("https://www.gamestop.com/")
  })
})

describe("product page modules", () => {
  it("pauses for a missing session before any request", async () => {
    for (const entry of modules) {
      const fake = client(() => json(200, productPage("Item", "https://schema.org/InStock")))
      const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http, { account: account(entry.id, false) }))
      expect(result.outcome, entry.id).toBe("paused")
      expect(fake.calls, entry.id).toHaveLength(0)
    }
  })

  it("does not add to cart for a guest login page", async () => {
    for (const entry of modules) {
      const fake = client(() => json(200, loginHtml))
      const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http))
      expect(result.outcome, entry.id).toBe("paused")
      if (result.outcome === "paused") expect(result.reason).toMatch(/not signed in/)
      expect(fake.calls.every((call) => call.method === "GET"), entry.id).toBe(true)
      expect(fake.calls.some((call) => /cart|checkout|place/i.test(call.url)), entry.id).toBe(false)
    }
  })

  it("does not post when a preorder page has no cart form", async () => {
    for (const entry of modules) {
      const fake = client(() => json(200, productPage("Pokemon Day 2026", "https://schema.org/PreOrder")))
      const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http, { testMode: true }))
      expect(result.outcome, entry.id).toBe("paused")
      if (result.outcome === "paused") expect(result.reason, entry.id).toBe(pageHandoff("Pokemon Day 2026"))
      expect(fake.calls.every((call) => call.method === "GET"), entry.id).toBe(true)
      expect(fake.calls.some((call) => isFinalSubmit(entry.id, call)), entry.id).toBe(false)
      expect(new Set(fake.calls.map((call) => new URL(call.url).hostname)), entry.id).toEqual(new Set([entry.host]))
      const bodies = fake.calls.map((call) => call.body ?? "").join("\n")
      expect(bodies).not.toContain(pan)
    }
  })

  it("pauses a live in-stock reading and tells the user to add it in the browser", async () => {
    const fake = client(() => json(200, productPage("Pokemon Day 2026", "https://schema.org/InStock")))
    const result = await createGameStopModule().run(runCtx("gamestop", modules[0].sku, fake.http))
    expect(result).toMatchObject({ outcome: "paused" })
    if (result.outcome === "paused") {
      expect(result.reason).toBe(pageHandoff("Pokemon Day 2026"))
      expect(result.reason).toContain("did not add it to the cart")
      expect(classifyChallenge(result.reason)).toBe(false)
    }
    expect(fake.calls.some((call) => call.method === "POST")).toBe(false)
  })

  it("pauses when the product page is a challenge", async () => {
    const fake = client(() => json(403, challengeHtml))
    const result = await createGameStopModule().run(runCtx("gamestop", modules[0].sku, fake.http))
    expect(result).toEqual({ outcome: "paused", reason: GAMESTOP_PAUSE })
    expect(classifyChallenge(GAMESTOP_PAUSE)).toBe(true)
    expect(classifyChallenge(COSTCO_PAUSE)).toBe(true)
    expect(fake.calls).toHaveLength(1)
  })

  it("keeps watching a Costco page that has no add control", async () => {
    const controller = new AbortController()
    const details: string[] = []
    const fake = client(() => json(200, productPage("Elite Trainer Box", "https://schema.org/OutOfStock", "off")))
    const result = await createCostcoModule().run(runCtx("costco", modules[2].sku, fake.http, {
      signal: controller.signal,
      detail: (message) => details.push(message),
      sleep: async () => controller.abort()
    }))
    expect(result.outcome).toBe("stopped")
    expect(details.some((line) => line.includes("Warehouse inventory was not read"))).toBe(true)
    expect(fake.calls.every((call) => new URL(call.url).hostname === "www.costco.com")).toBe(true)
    expect(fake.calls.some((call) => call.url.includes("ecom-api"))).toBe(false)
  })

  it("accepts a product URL in bulk create and a restock line", () => {
    const parsed = parseBulkTasks({
      text: modules[0].sku,
      store: "target",
      quantity: 1,
      profileId: "p1",
      accountId: "a1",
      proxyGroupId: null,
      confirmPurchase: false,
      testMode: true,
      group: ""
    })
    expect(parsed.tasks[0]?.store).toBe("gamestop")
    expect(parsed.tasks[0]?.sku).toBe("436435")
    const signals = parseDiscordContent("costco 100000001 Elite Trainer Box $39.99")
    expect(signals[0]?.store).toBe("costco")
    expect(signals[0]?.sku).toBe("100000001")
  })
})
