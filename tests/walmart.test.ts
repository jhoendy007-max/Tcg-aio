import { expectDryRunReport, recorder } from "./helpers/dry-run"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { isFinalSubmit } from "../src/engine/test-mode"
import { createWalmartModule, WALMART_PAUSE } from "../src/stores/walmart"
import { isChallenge, parseItemId, readStock } from "../src/stores/walmart/parse"
import { parsePieKey, protectPanAndCvv } from "../src/stores/walmart/pie"
import type { StoreRunContext } from "../src/stores/module"

const marketplace = readFileSync(new URL("./fixtures/walmart-offers-marketplace.json", import.meta.url), "utf8")
const internal = readFileSync(new URL("./fixtures/walmart-internal.json", import.meta.url), "utf8")
const above = readFileSync(new URL("./fixtures/walmart-above-msrp.json", import.meta.url), "utf8")
const challenge = readFileSync(new URL("./fixtures/walmart-challenge.json", import.meta.url), "utf8")
const pieFixture = JSON.parse(readFileSync(new URL("./fixtures/walmart-pie.json", import.meta.url), "utf8")) as {
  script: string
  pan: string
  cvv: string
  encryptedPan: string
  encryptedCvv: string
  integrityCheck: string
  phase1: { encryptedPan: string; encryptedCvv: string; integrityCheck: string }
}

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
  if (url.includes("getkey.js")) return { status: 200, headers: {}, body: pieFixture.script }
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
    const key = fake.calls.find((call) => call.url.includes("getkey.js"))
    expect(key?.method).toBe("GET")
    expect(new URL(key?.url ?? "https://invalid").hostname).toBe("securedataweb.walmart.com")
    expect(key?.body ?? "").not.toContain(pieFixture.pan)
    const pay = fake.calls.find((call) => call.url.includes("CreateAccountCreditCard"))
    expect(new URL(pay?.url ?? "https://invalid").hostname).toBe("www.walmart.com")
    expect(JSON.parse(pay?.body ?? "{}").variables.input).toMatchObject({
      encryptedPan: pieFixture.encryptedPan,
      encryptedCVV: pieFixture.encryptedCvv,
      integrityCheck: pieFixture.integrityCheck,
      keyId: "2595de71",
      phase: 0
    })
    expect(pay?.body ?? "").not.toContain(pieFixture.pan)
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
    expect(fake.calls.some((call) => (call.body ?? "").includes(pieFixture.pan))).toBe(false)
    const cardCalls = fake.calls.filter((call) => call.url.includes("CreateAccountCreditCard"))
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
    expect(fake.calls.filter((call) => call.url.includes("GetAllSellerOffers"))).toHaveLength(3)
    expect(fake.calls.some((call) => call.url.includes("updateItems"))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("CreateAccountCreditCard"))).toBe(false)
  })

  it("rotates to the next proxy after an HTTP 412 and then continues", async () => {
    const proxies = [
      { id: "a", host: "10.0.0.1", port: 8000 },
      { id: "b", host: "10.0.0.2", port: 8001 }
    ]
    let offers = 0
    const logs: string[] = []
    const sleeps: number[] = []
    const fake = client((req) => {
      if (req.url.includes("GetAllSellerOffers")) {
        offers += 1
        if (offers === 1) {
          expect(req.proxy?.host).toBe("10.0.0.1")
          return json(412, challenge)
        }
        expect(req.proxy?.host).toBe("10.0.0.1")
        return json(200, internal)
      }
      return happy(req)
    })
    const result = await createWalmartModule().run(ctx(fake.http, {
      proxy: proxies[0],
      proxies,
      log: (_level, message) => logs.push(message),
      sleep: async (ms) => { sleeps.push(ms) }
    }))
    expect(result).toMatchObject({ outcome: "success", orderId: "WM100" })
    expect(offers).toBe(2)
    expect(sleeps).toEqual([1000])
    expect(logs.some((line) => line.includes("HTTP 412") && line.includes("10.0.0.1:8000") && line.includes("Keeping this account's sticky proxy"))).toBe(true)
  })

  it("moves to the next proxy after an HTTP 412 when the task has no account", async () => {
    const proxies = [
      { id: "a", host: "10.0.0.1", port: 8000 },
      { id: "b", host: "10.0.0.2", port: 8001 }
    ]
    let offers = 0
    const logs: string[] = []
    const fake = client((req) => {
      if (req.url.includes("GetAllSellerOffers")) {
        offers += 1
        if (offers === 1) return json(412, challenge)
        expect(req.proxy?.host).toBe("10.0.0.2")
        return json(200, internal)
      }
      return happy(req)
    })
    const result = await createWalmartModule().run(ctx(fake.http, {
      account: { ...account, id: "" },
      proxy: proxies[0],
      proxies,
      log: (_level, message) => logs.push(message)
    }))
    expect(result).toMatchObject({ outcome: "success", orderId: "WM100" })
    expect(logs.some((line) => line.includes("Rotating to proxy 10.0.0.2:8001"))).toBe(true)
  })

  it("pauses after the 412 budget when the group has no other proxy", async () => {
    const sleeps: number[] = []
    const logs: string[] = []
    const fake = client((req) => {
      if (req.url.includes("GetAllSellerOffers")) return json(412, challenge)
      if (req.url.includes("/getCart/")) return json(200, { data: { cart: { id: "cart-1" } } })
      return json(500, "should not run")
    })
    const result = await createWalmartModule().run(ctx(fake.http, {
      proxy: { id: "a", host: "10.0.0.9", port: 9000 },
      proxies: [{ id: "a", host: "10.0.0.9", port: 9000 }],
      log: (_level, message) => logs.push(message),
      sleep: async (ms) => { sleeps.push(ms) }
    }))
    expect(result).toMatchObject({ outcome: "paused", reason: WALMART_PAUSE })
    expect(fake.calls.filter((call) => call.url.includes("GetAllSellerOffers"))).toHaveLength(3)
    expect(sleeps).toEqual([1000, 2000])
    expect(logs.some((line) => line.includes("Keeping this account's sticky proxy"))).toBe(true)
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

  it("does not retry place order when checkout asks for the CVV", async () => {
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
    expect(result).toMatchObject({ outcome: "paused" })
    if (result.outcome === "paused") expect(result.reason).toMatch(/did not retry the place-order request/i)
    expect(orders).toBe(1)
    const cards = fake.calls.filter((call) => call.url.includes("CreateAccountCreditCard"))
    expect(cards).toHaveLength(1)
    expect(cards.every((call) => new URL(call.url).hostname === "www.walmart.com")).toBe(true)
    expect(fake.calls.filter((call) => call.url.includes("getkey.js"))).toHaveLength(1)
    expect(cards.every((call) => !(call.body ?? "").includes(pieFixture.pan))).toBe(true)
  })

  it("does not retry place order when Walmart reports unavailable stock", async () => {
    const fake = client((req) => isFinalSubmit("walmart", req)
      ? json(409, { errors: [{ message: "OUT_OF_STOCK" }] })
      : happy(req))
    const result = await createWalmartModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    expect(fake.calls.filter((call) => isFinalSubmit("walmart", call))).toHaveLength(1)
  })

  it("runs payment and never sends place order in test mode", async () => {
    const fake = client((req) => happy(req))
    const rec = recorder()
    const result = await createWalmartModule().run(ctx(fake.http, { testMode: true, ...rec.part }))
    expectDryRunReport(rec, result, { stages: ["monitor","cart","payment","place"], cart: "left" })
    expect(result.outcome).toBe("tested")
    expect(fake.calls.some((call) => call.url.includes("CreateAccountCreditCard"))).toBe(true)
    expect(fake.calls.some((call) => isFinalSubmit("walmart", call))).toBe(false)
  })
})

describe("Walmart dry run cart cleanup (0.2.46)", () => {
  it("reports the removal, and says so when Walmart refuses it", async () => {
    const fake = client((req) => happy(req))
    const rec = recorder()
    const result = await createWalmartModule().run(ctx(fake.http, { testMode: true, clearCartAfterTest: true, ...rec.part }))
    expectDryRunReport(rec, result, { stages: ["monitor", "cart", "payment", "place"], cart: "removed" })
    expect(fake.calls.some((call) => call.url.includes("/updateItems/") && (call.body ?? "").includes('"quantity":0'))).toBe(true)

    const refused = client((req) => req.url.includes("/updateItems/") && (req.body ?? "").includes('"quantity":0') ? json(200, { errors: [{ message: "CART_BUSY" }] }) : happy(req))
    const failed = recorder()
    const second = await createWalmartModule().run(ctx(refused.http, { testMode: true, clearCartAfterTest: true, ...failed.part }))
    expect(second.outcome).toBe("tested")
    expect(failed.marks.some((mark) => mark.stage === "cart" && mark.result === "fail" && /by hand/i.test(mark.detail))).toBe(true)
    expect(failed.logs.some((entry) => entry.level === "warn" && /still in your cart/i.test(entry.message))).toBe(true)
  })
})

describe("walmart PIE", () => {
  it("matches the PIE embed=false ciphertext for a fixed key", () => {
    const key = parsePieKey(pieFixture.script)
    expect(key).toMatchObject({ L: 6, E: 4, K: "70E99B247C0E6B77679F65F1D721B120", keyId: "2595de71", phase: 0 })
    expect(protectPanAndCvv(pieFixture.pan, pieFixture.cvv, key!)).toMatchObject({
      encryptedPan: pieFixture.encryptedPan,
      encryptedCvv: pieFixture.encryptedCvv,
      integrityCheck: pieFixture.integrityCheck
    })
    expect(protectPanAndCvv("4242 4242 4242 4242", pieFixture.cvv, key! )?.encryptedPan).toBe(pieFixture.encryptedPan)
    expect(protectPanAndCvv("4242424242424243", pieFixture.cvv, key!)).toBeNull()
    expect(protectPanAndCvv(pieFixture.pan, pieFixture.cvv, { ...key!, phase: 1 })).toMatchObject(pieFixture.phase1)
  })
})
