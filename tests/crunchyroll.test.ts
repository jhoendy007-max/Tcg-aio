import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { isFinalSubmit } from "../src/engine/test-mode"
import { CRUNCHYROLL_PAUSE, createCrunchyrollModule } from "../src/stores/crunchyroll"
import { commerceCardType, readPaymentMethod, stripePaymentMethodBody } from "../src/stores/crunchyroll/card"
import { isChallenge, parseSku, productApiUrl, readStock } from "../src/stores/crunchyroll/parse"
import type { StoreRunContext } from "../src/stores/module"

const cloudflare = readFileSync(new URL("./fixtures/crunchyroll-cloudflare.html", import.meta.url), "utf8")
const sku = "810158836396"
const productUrl = `https://store.crunchyroll.com/products/one-piece-the-azure-seas-seven-one-piece-trading-card-game-booster-box-${sku}.html`
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
    line2: "Apt 2",
    city: "New York",
    state: "NY",
    zip: "10001",
    country: "US"
  },
  billing: {
    firstName: "Ada",
    lastName: "Lovelace",
    line1: "9 Billing Rd",
    line2: "",
    city: "Brooklyn",
    state: "NY",
    zip: "11201",
    country: "US"
  },
  cardName: "Ada Lovelace",
  last4: "4242",
  expMonth: "12",
  expYear: "2030",
  card: { name: "Ada Lovelace", number: pan, cvv: "123", expMonth: "12", expYear: "2030" }
}

function jwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

const token = jwt({ sub: "customer-1", aut: "GUID", isb: "uido:Registered||customer-1" })
const account: FullAccount = {
  id: "a1",
  store: "crunchyroll",
  label: "Main",
  username: "ada@example.com",
  session: { accessToken: token }
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
    task: { id: "t1", sku: productUrl, quantity: 1, store: "crunchyroll" },
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

function shopper(orderable: boolean, price = 124.99, list = 124.99, name = "One Piece - The Azure Sea's Seven Booster Box"): unknown {
  return {
    id: sku,
    name,
    price,
    inventory: { id: "inventory", orderable, ats: orderable ? 4 : 0, stockLevel: orderable ? 4 : 0 },
    tieredPrices: [
      { price, pricebook: "usd-sale-prices" },
      { price: list, pricebook: "usd-list-prices" }
    ]
  }
}

function variation(available: boolean, sales = 107.99, list: number | null = 107.99): string {
  return JSON.stringify({
    product: {
      id: "810059787315",
      productName: "One Piece - Four Emperors Booster Box",
      available,
      price: { sales: { value: sales, currency: "USD" }, list: list === null ? null : { value: list, currency: "USD" } },
      availability: { messages: [available ? "In Stock" : "Currently Unavailable"] }
    }
  })
}

function methods(): unknown {
  return {
    applicableShippingMethods: [
      { id: "pickup", name: "Store Pickup", c_storePickupEnabled: true },
      { id: "standard", name: "Standard Shipping", c_storePickupEnabled: false }
    ]
  }
}

function happy(req: HttpRequest, order: unknown = { orderNo: "CR100" }, stock: unknown = shopper(true)): HttpResponse {
  const url = req.url
  if (url.includes("/shopper-products/")) return json(200, stock)
  if (url.includes("/baskets?siteId=")) return json(200, { basketId: "basket-1", orderTotal: 124.99 })
  if (url.includes("/customer?")) return json(200, { email: "ada@example.com" })
  if (url.includes("/shipping-address")) return json(200, {})
  if (url.includes("/shipping-methods")) return json(200, methods())
  if (url.includes("/shipping-method")) return json(200, { orderTotal: 124.99 })
  if (url.includes("/store/products/")) return json(200, `<html><script>stripePublicKey = "pk_live_51CrunchyrollTest"</script></html>`)
  if (url.includes("api.stripe.com")) {
    return json(200, { id: "pm_123", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } })
  }
  if (url.includes("/payment-instruments")) return json(200, { paymentInstrumentId: "pi-1" })
  if (url.includes("/shopper-orders/")) return json(200, order)
  throw new Error(`unexpected ${req.method} ${url}`)
}

describe("crunchyroll parser", () => {
  it("reads a product id from a bare id or a store URL", () => {
    expect(parseSku(sku)).toBe(sku)
    expect(parseSku(productUrl)).toBe(sku)
    expect(parseSku("https://store.crunchyroll.com/products/-810059787315.html")).toBe("810059787315")
    expect(parseSku("https://www.crunchyroll.com/store/products/zephyr-810158838444.html")).toBe("810158838444")
    expect(parseSku("not-a-sku")).toBeNull()
    expect(productApiUrl(sku)).toContain(`/products/${sku}`)
    expect(productApiUrl(sku)).toContain("siteId=CrunchyrollUS")
    expect(new URL(productApiUrl(sku)).hostname).toBe("www.crunchyroll.com")
  })

  it("reads shopper inventory and a Product-Variation payload at the store price", () => {
    expect(readStock(JSON.stringify(shopper(true)), sku)).toMatchObject({ inStock: true, status: "IN_STOCK", price: 124.99, listPrice: 124.99 })
    expect(readStock(JSON.stringify(shopper(false, 124.99, 124.99)), sku)?.inStock).toBe(false)
    expect(readStock(JSON.stringify(shopper(true, 180, 124.99)), sku)).toMatchObject({ inStock: false, status: "ABOVE_PRICE" })
    expect(readStock(variation(false), "810059787315")).toMatchObject({ inStock: false, status: "OUT_OF_STOCK", price: 107.99 })
    expect(readStock(variation(true), "810059787315")?.inStock).toBe(true)
  })

  it("treats the live Cloudflare challenge as a block and a product payload as stock", () => {
    expect(isChallenge(403, cloudflare, "challenge")).toBe(true)
    expect(isChallenge(403, cloudflare)).toBe(true)
    expect(isChallenge(200, JSON.stringify(shopper(true)))).toBe(false)
  })
})

describe("crunchyroll stripe card", () => {
  it("builds a PaymentMethod body and reads the token without keeping the card on the store", () => {
    const body = stripePaymentMethodBody({
      number: pan,
      cvc: "123",
      expMonth: "12",
      expYear: "2030",
      name: "Ada Lovelace",
      line1: "9 Billing Rd",
      city: "Brooklyn",
      state: "NY",
      postalCode: "11201"
    })
    expect(body).toContain(`card%5Bnumber%5D=${pan}`)
    expect(commerceCardType(pan)).toBe("Visa")
    expect(commerceCardType("5555555555554444")).toBe("MasterCard")
    expect(readPaymentMethod(JSON.stringify({ id: "pm_123", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } }))?.id).toBe("pm_123")
  })
})

describe("crunchyroll checkout", () => {
  it("checks out ship-to-home and sends the card only to Stripe", async () => {
    const fake = client((req) => happy(req))
    const result = await createCrunchyrollModule().run(ctx(fake.http, {
      task: { id: "t1", sku, quantity: 2, store: "crunchyroll" }
    }))
    expect(result).toMatchObject({ outcome: "success", orderId: "CR100" })
    const hosts = new Set(fake.calls.map((call) => new URL(call.url).hostname))
    expect([...hosts].sort()).toEqual(["api.stripe.com", "www.crunchyroll.com"])
    const stripe = fake.calls.find((call) => call.url.includes("api.stripe.com"))
    expect(stripe?.body).toContain(pan)
    expect(stripe?.headers?.authorization).toBe("Bearer pk_live_51CrunchyrollTest")
    const storeCalls = fake.calls.filter((call) => call.url.includes("crunchyroll.com"))
    const leaked = storeCalls.find((call) => call.body?.includes(pan) || call.body?.includes("card[cvc]") || call.body?.includes("card%5Bcvc") || call.body?.includes(pan.slice(0, 8)))
    expect(leaked?.url ?? "").toBe("")
    expect(leaked?.body ?? "").toBe("")
    const instrument = fake.calls.find((call) => call.url.includes("payment-instruments"))
    expect(JSON.parse(instrument?.body ?? "{}")).toMatchObject({
      paymentMethodId: "STRIPE",
      c_stripePaymentMethodId: "pm_123",
      amount: 124.99,
      paymentCard: { maskedNumber: "************4242", cardType: "Visa" }
    })
    const basket = fake.calls.find((call) => call.method === "POST" && call.url.includes("/baskets?"))
    expect(JSON.parse(basket?.body ?? "{}")).toMatchObject({ productItems: [{ productId: sku, quantity: 2 }] })
    const address = fake.calls.find((call) => call.url.includes("shipping-address"))
    expect(JSON.parse(address?.body ?? "{}")).toMatchObject({ address1: "1 Main St", stateCode: "NY", countryCode: "US" })
    expect(address?.body).not.toContain("9 Billing Rd")
    const method = fake.calls.find((call) => call.url.includes("/shipping-method?"))
    expect(JSON.parse(method?.body ?? "{}")).toEqual({ id: "standard" })
    expect(fake.calls.some((call) => call.url.includes("/shopper-products/") && call.url.includes(sku))).toBe(true)
    expect(fake.calls[0]?.headers?.authorization).toBe(`Bearer ${token}`)
  })

  it("waits while the store price is above list or the item is unavailable", async () => {
    let checks = 0
    const fake = client((req) => {
      if (req.url.includes("/shopper-products/")) {
        checks += 1
        return json(200, checks === 1 ? shopper(true, 180, 124.99) : shopper(true))
      }
      return happy(req)
    })
    let slept = 0
    const result = await createCrunchyrollModule().run(ctx(fake.http, { sleep: async () => { slept += 1 } }))
    expect(result).toMatchObject({ outcome: "success", orderId: "CR100" })
    expect(checks).toBe(2)
    expect(slept).toBeGreaterThan(0)
  })

  it("pauses on the live Cloudflare challenge before add to cart", async () => {
    const fake = client(() => json(403, cloudflare, { "cf-mitigated": "challenge" }))
    const result = await createCrunchyrollModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "paused", reason: CRUNCHYROLL_PAUSE })
    expect(fake.calls.some((call) => call.url.includes("/baskets"))).toBe(false)
  })

  it("makes no requests without a session or with a guest token", async () => {
    const missing = client(() => json(200, {}))
    expect((await createCrunchyrollModule().run(ctx(missing.http, { account: { ...account, session: undefined } }))).outcome).toBe("paused")
    expect(missing.calls).toHaveLength(0)
    const guest = client(() => json(200, {}))
    const guestToken = jwt({ isb: "uido:Guest||guest-1", aut: "GUEST" })
    const guestResult = await createCrunchyrollModule().run(ctx(guest.http, { account: { ...account, session: { accessToken: guestToken } } }))
    expect(guestResult.outcome).toBe("paused")
    expect(guest.calls).toHaveLength(0)
  })

  it("pauses an expired session", async () => {
    const fake = client(() => json(401, { title: "Unauthorized", detail: "invalid access token" }))
    const result = await createCrunchyrollModule().run(ctx(fake.http))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(result.reason).toMatch(/expired/i)
  })

  it("fails pickup-only checkout before Stripe", async () => {
    const fake = client((req) => {
      if (req.url.includes("/shipping-methods")) return json(200, { applicableShippingMethods: [{ id: "pickup", name: "Pickup", c_storePickupEnabled: true }] })
      return happy(req)
    })
    const result = await createCrunchyrollModule().run(ctx(fake.http))
    expect(result.outcome).toBe("failed")
    if (result.outcome === "failed") expect(result.reason).toMatch(/pickup/i)
    expect(fake.calls.some((call) => call.url.includes("api.stripe.com"))).toBe(false)
  })

  it("reports a declined card without claiming an order", async () => {
    const fake = client((req) => {
      if (req.url.includes("api.stripe.com")) return json(402, { error: { code: "card_declined", message: "Your card was declined." } })
      return happy(req)
    })
    const result = await createCrunchyrollModule().run(ctx(fake.http))
    expect(result.outcome).toBe("failed")
    if (result.outcome === "failed") expect(result.reason).toMatch(/declined/i)
    expect(fake.calls.some((call) => call.url.includes("/shopper-orders/"))).toBe(false)
  })

  it("pauses when Stripe requires authentication", async () => {
    const fake = client((req) => happy(req, { status: "requires_action", next_action: { type: "redirect_to_url" } }))
    const result = await createCrunchyrollModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "paused", reason: CRUNCHYROLL_PAUSE })
  })

  it("returns to the monitor when the basket says the item is unavailable", async () => {
    let baskets = 0
    const fake = client((req) => {
      if (req.url.includes("/baskets?siteId=")) {
        baskets += 1
        if (baskets === 1) return json(400, { title: "Product Item Not Available", type: "product-item-not-available" })
      }
      return happy(req)
    })
    const result = await createCrunchyrollModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "success", orderId: "CR100" })
    expect(baskets).toBe(2)
  })

  it("does not retry place order when Crunchyroll reports unavailable stock", async () => {
    const fake = client((req) => isFinalSubmit("crunchyroll", req)
      ? json(409, { error: "OUT_OF_STOCK" })
      : happy(req))
    const result = await createCrunchyrollModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    expect(fake.calls.filter((call) => isFinalSubmit("crunchyroll", call))).toHaveLength(1)
  })

  it("tokenizes the card and never sends place order in test mode", async () => {
    const fake = client((req) => happy(req))
    const result = await createCrunchyrollModule().run(ctx(fake.http, { testMode: true }))
    expect(result.outcome).toBe("tested")
    expect(fake.calls.some((call) => call.url.includes("api.stripe.com"))).toBe(true)
    expect(fake.calls.some((call) => isFinalSubmit("crunchyroll", call))).toBe(false)
  })
})
