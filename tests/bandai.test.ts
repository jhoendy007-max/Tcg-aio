import { expectDryRunReport, recorder } from "./helpers/dry-run"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseBulkTasks } from "../src/engine/bulk"
import { classifyChallenge } from "../src/engine/challenge"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { parseListings } from "../src/engine/listings"
import { parseDiscordContent } from "../src/engine/restock-parse"
import { isFinalSubmit } from "../src/engine/test-mode"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import { BANDAI_PAUSE, createBandaiModule } from "../src/stores/bandai"
import { isChallenge, parseSku, productApiUrl, readStock } from "../src/stores/bandai/parse"
import type { StoreRunContext } from "../src/stores/module"

const open = readFileSync(new URL("./fixtures/bandai-open.json", import.meta.url), "utf8")
const closed = readFileSync(new URL("./fixtures/bandai-closed.json", import.meta.url), "utf8")
const challenge = readFileSync(new URL("./fixtures/bandai-challenge.html", import.meta.url), "utf8")
const search = readFileSync(new URL("./fixtures/bandai-search.json", import.meta.url), "utf8")
const sku = "N2884152001"
const page = `https://p-bandai.com/us/item/${sku}`
const pan = "4242424242424242"

const profile: FullProfile = {
  id: "p1",
  name: "Home",
  email: "ada@example.com",
  phone: "2125550100",
  shipping: {
    firstName: "Ada",
    lastName: "Lovelace",
    line1: "1 Main St",
    line2: "",
    city: "New York",
    state: "NY",
    zip: "10001",
    country: "US"
  },
  billing: {
    firstName: "Ada",
    lastName: "Lovelace",
    line1: "1 Main St",
    line2: "",
    city: "New York",
    state: "NY",
    zip: "10001",
    country: "US"
  },
  cardName: "Ada Lovelace",
  last4: "4242",
  expMonth: "12",
  expYear: "2030",
  card: { name: "Ada Lovelace", number: pan, cvv: "123", expMonth: "12", expYear: "2030" }
}

const account: FullAccount = {
  id: "a1",
  store: "bandai",
  label: "Main",
  username: "ada@example.com",
  session: { accessToken: "session", cookie: "SESSION=signed-in" }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body) }
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

function ctx(http: HttpClient, overrides: Partial<StoreRunContext> = {}): StoreRunContext {
  return {
    task: { id: "t1", sku: page, quantity: 1, store: "bandai" },
    profile,
    account,
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

function happy(req: HttpRequest): HttpResponse {
  if (req.url.includes("/api/context/member")) return json(200, { isLoggedIn: true, csrfToken: "csrf-1" })
  if (req.url.includes("/api/products/")) return json(200, open)
  if (req.url.includes("/api/cart/addToCart")) return json(200, { items: [{ addedNewCart: true }], totalCartCount: 1 })
  if (req.url.includes("/api/cart/removeCartLineItems")) return json(200, { totalCartCount: 0 })
  if (req.url.includes("/api/cart/detail")) {
    return json(200, {
      cartId: "cart-1",
      cartSn: "sn-1",
      globaleMerchantCartTokenSuffix: "US",
      combinedShippings: [{ lineItems: [{ product: { cartItemSn: "line-1", productCode: sku, areaItemNo: "NAI0850326US" } }] }]
    })
  }
  if (req.url.includes("/checkout")) return json(200, { checkoutSn: 42 })
  if (req.url.includes("/preComplete")) return json(200, { orderNo: "SHOULD-NOT-RUN" })
  return json(404, { error: "unexpected" })
}

describe("bandai parser", () => {
  it("reads a product code from the current item URL and the older item_ path", () => {
    expect(parseSku(page)).toBe(sku)
    expect(parseSku("https://p-bandai.com/us/item/N2773431001001/")).toBe("N2773431001001")
    expect(parseSku("https://p-bandai.com/us/item/detail/item_1234567")).toBe("1234567")
    expect(parseSku("item_998877")).toBe("998877")
    expect(parseSku("https://example.com/item/N2884152001")).toBeNull()
    expect(new URL(productApiUrl(sku)).hostname).toBe("p-bandai.com")
  })

  it("treats an open preorder as available and a closed preorder as out of stock", () => {
    const live = readStock(open, sku)
    expect(live?.inStock).toBe(true)
    expect(live?.status).toBe("PRE_ORDER")
    expect(live?.price).toBe(66)
    expect(live?.areaItemNo).toBe("NAI0850326US")
    const ended = readStock(closed, "N2716225001")
    expect(ended?.inStock).toBe(false)
    expect(ended?.status).toBe("OUT_OF_STOCK")
    expect(isChallenge(200, challenge)).toBe(true)
    expect(isChallenge(200, open)).toBe(false)
  })

  it("keeps closed search hits out of the keyword list", () => {
    const listings = parseListings("bandai", search)
    expect(listings.map((item) => item.sku)).toEqual([sku])
    expect(listings[0]?.price).toBe(66)
    expect(listings[0]?.url).toBe(page)
  })
})

describe("bandai checkout", () => {
  it("starts checkout and does not submit the order confirmation", async () => {
    const fake = client(happy)
    const result = await createBandaiModule().run(ctx(fake.http))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") {
      expect(result.reason).toMatch(/Global-e/)
      expect(result.reason).toMatch(/card number was not sent/)
      expect(classifyChallenge(result.reason)).toBe(false)
    }
    expect(fake.calls.some((call) => isFinalSubmit("bandai", call))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("/preComplete"))).toBe(false)
    const bodies = fake.calls.map((call) => call.body ?? "").join("\n")
    expect(bodies).not.toContain(pan)
    expect(bodies).not.toContain("123")
    const add = fake.calls.find((call) => call.url.includes("/addToCart"))
    expect(add?.headers?.["x-csrf-token"]).toBe("csrf-1")
    expect(add?.headers?.["x-g1-area-code"]).toBe("us")
    expect(JSON.parse(add?.body ?? "[]")).toEqual([{ areaItemNo: "NAI0850326US", qty: 1 }])
    const hosts = new Set(fake.calls.map((call) => new URL(call.url).hostname))
    expect([...hosts]).toEqual(["p-bandai.com"])
  })

  it("runs through checkout start in test mode and never calls preComplete", async () => {
    const fake = client(happy)
    const marks: string[] = []
    const result = await createBandaiModule().run(ctx(fake.http, {
      testMode: true,
      mark: (_stage, check, detail) => marks.push(`${check}:${detail}`)
    }))
    expect(result.outcome).toBe("tested")
    expect(fake.calls.some((call) => call.url.includes("/api/cart/sn-1/checkout"))).toBe(true)
    expect(fake.calls.some((call) => isFinalSubmit("bandai", call))).toBe(false)
    expect(marks.some((line) => line.startsWith("skip:") && line.includes("card number was not sent"))).toBe(true)
  })

  it("dry run report lists every step, removes the test line when asked, and warns when it could not", async () => {
    const left = recorder()
    const first = await createBandaiModule().run(ctx(client(happy).http, { testMode: true, ...left.part }))
    expectDryRunReport(left, first, { stages: ["monitor", "cart", "address", "shipping", "payment", "place"], cart: "left" })

    const fake = client(happy)
    const clean = recorder()
    const second = await createBandaiModule().run(ctx(fake.http, { testMode: true, clearCartAfterTest: true, ...clean.part }))
    expectDryRunReport(clean, second, { stages: ["monitor", "cart", "address", "shipping", "payment", "place"], cart: "removed" })
    expect(fake.calls.some((call) => call.method === "DELETE" && call.url.includes("/api/cart/removeCartLineItems"))).toBe(true)

    const broken = client((req) => req.method === "DELETE" ? json(500, { error: "no" }) : happy(req))
    const failed = recorder()
    const third = await createBandaiModule().run(ctx(broken.http, { testMode: true, clearCartAfterTest: true, ...failed.part }))
    expect(third.outcome).toBe("tested")
    expect(failed.marks.some((mark) => mark.stage === "cart" && mark.result === "fail" && /by hand/i.test(mark.detail))).toBe(true)
    expect(failed.logs.some((entry) => entry.level === "warn" && /still in your cart/i.test(entry.message))).toBe(true)
  })

  it("pauses on the storefront challenge before add to cart", async () => {
    const fake = client((req) => req.url.includes("/context/member") ? json(200, challenge) : happy(req))
    const result = await createBandaiModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "paused", reason: BANDAI_PAUSE })
    expect(fake.calls.some((call) => call.url.includes("/addToCart"))).toBe(false)
  })

  it("does not add to cart when the session is missing or signed out", async () => {
    const missing = client(happy)
    expect((await createBandaiModule().run(ctx(missing.http, { account: { ...account, session: undefined } }))).outcome).toBe("paused")
    expect(missing.calls).toHaveLength(0)
    const guest = client(() => json(200, { isLoggedIn: false, csrfToken: "csrf-1" }))
    const guestResult = await createBandaiModule().run(ctx(guest.http))
    expect(guestResult.outcome).toBe("paused")
    expect(guest.calls.some((call) => call.url.includes("/addToCart"))).toBe(false)
  })

  it("retries a monitor error and returns to the monitor when the cart says the item is gone", async () => {
    let products = 0
    let adds = 0
    const fake = client((req) => {
      if (req.url.includes("/api/products/")) {
        products += 1
        if (products === 1) return json(500, { error: "Internal Server Error" })
        if (products === 2) return json(200, closed)
      }
      if (req.url.includes("/addToCart")) {
        adds += 1
        if (adds === 1) return json(400, { error: "CouldNotAddToCartByOutOfStock" })
      }
      return happy(req)
    })
    const result = await createBandaiModule().run(ctx(fake.http))
    expect(result.outcome).toBe("paused")
    expect(products).toBeGreaterThanOrEqual(3)
    expect(adds).toBe(2)
    expect(fake.calls.some((call) => call.url.includes("/preComplete"))).toBe(false)
  })

  it("accepts a pasted product URL in bulk create and a restock line", () => {
    const parsed = parseBulkTasks({
      text: page,
      store: "target",
      quantity: 1,
      profileId: "p",
      accountId: "a",
      proxyGroupId: null,
      confirmPurchase: false,
      testMode: true,
      group: ""
    })
    expect(parsed.tasks[0]?.store).toBe("bandai")
    expect(parsed.tasks[0]?.sku).toBe(sku)
    const signals = parseDiscordContent("bandai N2884152001 Digimon battle set $66.00")
    expect(signals[0]?.store).toBe("bandai")
    expect(signals[0]?.sku).toBe(sku)
    expect(signals[0]?.price).toBe(66)
  })
})
