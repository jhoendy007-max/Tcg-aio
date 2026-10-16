import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { createWalmartModule, WALMART_PAUSE } from "../src/stores/walmart"
import { isChallenge, parseItemId, readStock } from "../src/stores/walmart/parse"
import type { StoreRunContext } from "../src/stores/module"

const marketplace = readFileSync(new URL("./fixtures/walmart-offers-marketplace.json", import.meta.url), "utf8")
const internal = readFileSync(new URL("./fixtures/walmart-internal.json", import.meta.url), "utf8")
const above = readFileSync(new URL("./fixtures/walmart-above-msrp.json", import.meta.url), "utf8")
const challenge = readFileSync(new URL("./fixtures/walmart-challenge.json", import.meta.url), "utf8")

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
  card: { name: "Ada Lovelace", number: "4242424242424242", cvv: "123", expMonth: "12", expYear: "2030" }
}

const account: FullAccount = {
  id: "a1",
  store: "walmart",
  label: "Main",
  username: "ada@example.com",
  session: { accessToken: "auth-token", visitorId: "cid-1", cookie: "auth=auth-token; CID=cid-1" }
}

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
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
    task: { id: "t1", sku: "https://www.walmart.com/ip/Pokemon-Prismatic-Evolutions-Elite-Trainer-Box/13816151308", quantity: 2, store: "walmart" },
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

function happy(req: HttpRequest, placeBody: unknown = { data: { placeOrder: { order: { id: "WM100" } } } }): HttpResponse {
  const url = req.url
  if (url.includes("GetAllSellerOffers")) return json(200, internal)
  if (url.includes("/getCart/")) return json(200, { data: { cart: { id: "cart-1" } } })
  if (url.includes("/updateItems/")) return json(200, { data: { updateItems: { id: "cart-1" } } })
  if (url.includes("/updateFulfillmentOption/")) return json(200, { data: { cart: { id: "cart-1" } } })
  if (url.includes("/CreateDeliveryAddress/")) return json(200, { data: { createDeliveryAddress: { newAddress: { id: "addr-1" } } } })
  if (url.includes("/setShipping/")) return json(200, { data: { fulfillmentMutations: { setShipping: { id: "cart-1" } } } })
  if (url.includes("/CreateAccountCreditCard/")) return json(200, { data: { createAccountCreditCard: { creditCard: { id: "pay-1" } } } })
  if (url.includes("/CreateBuyNowContract/")) return json(200, { data: { createBuyNowContract: { id: "contract-1" } } })
  if (url.includes("/placeOrder/")) return json(200, placeBody)
  return json(500, `unexpected ${req.method} ${url}`)
}

describe("walmart stock parser", () => {
  it("reads an item id from a bare id or a product URL", () => {
    expect(parseItemId("13816151308")).toBe("13816151308")
    expect(parseItemId("4048737")).toBe("4048737")
    expect(parseItemId("https://www.walmart.com/ip/Pokemon-Prismatic-Evolutions-Elite-Trainer-Box/13816151308")).toBe("13816151308")
    expect(parseItemId("https://www.walmart.com/ip/5521755697")).toBe("5521755697")
    expect(parseItemId("https://www.walmart.com/ip/seort/1160437186?itemId=1160437186")).toBe("1160437186")
    expect(parseItemId("not-an-item")).toBeNull()
  })

  it("ignores a fulfilled-by-Walmart marketplace offer from the live response shape", () => {
    const reading = readStock(marketplace)
    expect(reading).toMatchObject({
      inStock: false,
      status: "MARKETPLACE",
      seller: "Unbeatable deals",
      price: 134.66,
      offerId: "4763C7752084369991730F1A1E2CF118"
    })
  })

  it("accepts a Walmart.com shipping offer at the list price", () => {
    expect(readStock(internal)).toMatchObject({
      inStock: true,
      status: "IN_STOCK",
      seller: "Walmart.com",
      price: 49.99,
      offerId: "WALMART0FF3R0000000000000000001",
      title: "Pokemon Scarlet & Violet Elite Trainer Box"
    })
  })

  it("rejects a Walmart.com offer priced above the list price", () => {
    expect(readStock(above)).toMatchObject({ inStock: false, status: "ABOVE_MSRP", price: 89.99, msrp: 49.99 })
  })

  it("rejects pickup-only Walmart.com stock", () => {
    const reading = readStock(JSON.stringify({
      data: {
        product: {
          allOffers: [{
            offerId: "pickup-1",
            usItemId: "13816151308",
            sellerType: "INTERNAL",
            catalogSellerId: 0,
            sellerDisplayName: "Walmart.com",
            availabilityStatus: "IN_STOCK",
            fulfillmentType: "PICKUP",
            fulfillmentOptions: [{ type: "SHIPPING", availabilityStatus: "NOT_AVAILABLE" }],
            priceInfo: { currentPrice: { price: 49.99 }, listPrice: { price: 49.99 } }
          }]
        }
      }
    }))
    expect(reading).toMatchObject({ inStock: false, status: "NO_SHIPPING" })
  })

  it("does not treat a normal product page that mentions PerimeterX as a challenge", () => {
    const product = JSON.parse(internal) as { data: { product: unknown } }
    const html = `<html><head><meta http-equiv="Content-Security-Policy" content="*.perimeterx.net"></head><body><script>config "perimeterX":{"enable":true}</script><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { product: product.data.product } } } } })}</script></body></html>`
    expect(isChallenge(200, html)).toBe(false)
    expect(readStock(html)).toMatchObject({ inStock: true, status: "IN_STOCK" })
    expect(isChallenge(200, "<html><title>Robot or human?</title>press and hold</html>")).toBe(true)
    expect(isChallenge(412, challenge)).toBe(true)
    expect(isChallenge(403, "<html>access denied</html>")).toBe(true)
  })
})

describe("walmart module", () => {
  it("monitors, adds to cart, and checks out shipping only", async () => {
    const fake = client((req) => happy(req))
    const result = await createWalmartModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "success", orderId: "WM100" })
    const offers = fake.calls.find((call) => call.url.includes("GetAllSellerOffers"))
    expect(JSON.parse(offers?.body ?? "{}").variables).toMatchObject({ itemId: "13816151308", isSubscriptionEligible: false })
    expect(offers?.headers?.cookie).toBe("auth=auth-token; CID=cid-1")
    const atc = fake.calls.find((call) => call.url.includes("/updateItems/") && (call.body ?? "").includes('"quantity":2'))
    expect(JSON.parse(atc?.body ?? "{}").variables.input.items[0]).toMatchObject({
      offerId: "WALMART0FF3R0000000000000000001",
      usItemId: "13816151308",
      quantity: 2
    })
    const shipMode = fake.calls.find((call) => call.url.includes("updateFulfillmentOption"))
    expect(JSON.parse(shipMode?.body ?? "{}").variables.input.fulfillmentOption).toBe("SHIPPING")
    const address = fake.calls.find((call) => call.url.includes("CreateDeliveryAddress"))
    expect(JSON.parse(address?.body ?? "{}").variables.input.address).toMatchObject({
      addressLineOne: "1 Main St",
      city: "New York",
      isDefault: false
    })
    const pay = fake.calls.find((call) => call.url.includes("CreateAccountCreditCard"))
    expect(new URL(pay?.url ?? "https://invalid").hostname).toBe("www.walmart.com")
    expect(JSON.parse(pay?.body ?? "{}").variables.input.encryptedPan).toBe("4242424242424242")
    expect(JSON.parse(pay?.body ?? "{}").variables.input.address.addressLineOne).toBe("9 Billing Rd")
    const contract = fake.calls.find((call) => call.url.includes("CreateBuyNowContract"))
    expect(JSON.parse(contract?.body ?? "{}").variables).toMatchObject({
      items: [{ offerId: "WALMART0FF3R0000000000000000001", quantity: 2 }],
      shippingPreferenceId: "addr-1",
      paymentPreferenceId: "pay-1"
    })
    const order = fake.calls.find((call) => call.url.includes("/placeOrder/"))
    expect(JSON.parse(order?.body ?? "{}").variables.placeOrderInput).toMatchObject({
      contractId: "contract-1",
      emailAddress: "ada@example.com"
    })
    const cardCalls = fake.calls.filter((call) => (call.body ?? "").includes("4242424242424242"))
    expect(cardCalls.length).toBeGreaterThan(0)
    expect(cardCalls.every((call) => new URL(call.url).hostname === "www.walmart.com")).toBe(true)
    expect(fake.calls.some((call) => (call.body ?? "").includes("PICKUP"))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("/updateItems/") && (call.body ?? "").includes('"quantity":0'))).toBe(true)
  })

  it("pauses on a PerimeterX block before add to cart or payment", async () => {
    const fake = client((req) => {
      if (req.url.includes("GetAllSellerOffers")) return json(412, challenge)
      if (req.url.includes("/getCart/")) return json(200, { data: { cart: { id: "cart-1" } } })
      return json(500, "should not run")
    })
    const result = await createWalmartModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "paused", reason: WALMART_PAUSE })
    expect(fake.calls.some((call) => call.url.includes("updateItems"))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("CreateAccountCreditCard"))).toBe(false)
  })

  it("keeps watching a marketplace listing until Walmart.com has it", async () => {
    let checks = 0
    const fake = client((req) => {
      if (req.url.includes("GetAllSellerOffers")) {
        checks += 1
        return json(200, checks === 1 ? marketplace : internal)
      }
      return happy(req)
    })
    let slept = 0
    const result = await createWalmartModule().run(ctx(fake.http, { sleep: async () => { slept += 1 } }))
    expect(result.outcome).toBe("success")
    expect(checks).toBe(2)
    expect(slept).toBeGreaterThan(0)
  })

  it("falls back to the product page when the offers call has no reading", async () => {
    const fake = client((req) => {
      if (req.url.includes("GetAllSellerOffers")) return json(400, { code: 400, message: "Something went wrong while processing the query." })
      if (req.method === "GET" && req.url.includes("/ip/13816151308")) return json(200, internal)
      return happy(req)
    })
    const result = await createWalmartModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "success", orderId: "WM100" })
    expect(fake.calls.some((call) => call.method === "GET" && call.url.includes("/ip/13816151308"))).toBe(true)
  })

  it("pauses before any request when the account has no session", async () => {
    const fake = client(() => json(500, "should not run"))
    const result = await createWalmartModule().run(ctx(fake.http, {
      account: { ...account, session: undefined }
    }))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(result.reason).toMatch(/auth and CID/)
    expect(fake.calls).toHaveLength(0)
  })

  it("reports a declined card without claiming an order", async () => {
    const fake = client((req) => happy(req, { data: { placeOrder: null }, errors: [{ message: "PAYMENT_DECLINED" }] }))
    const result = await createWalmartModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    if (result.outcome === "failed") expect(result.reason).toMatch(/declined/i)
  })

  it("resubmits the card once when checkout asks for the CVV", async () => {
    let orders = 0
    const fake = client((req) => {
      if (req.url.includes("/placeOrder/")) {
        orders += 1
        if (orders === 1) return json(400, { errors: [{ message: "Please enter CVV" }] })
        return json(200, { data: { placeOrder: { order: { id: "WM555" } } } })
      }
      return happy(req)
    })
    const result = await createWalmartModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "success", orderId: "WM555" })
    const cards = fake.calls.filter((call) => call.url.includes("CreateAccountCreditCard"))
    expect(cards).toHaveLength(2)
    expect(cards.every((call) => new URL(call.url).hostname === "www.walmart.com")).toBe(true)
  })
})
