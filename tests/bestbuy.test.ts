import { expectDryRunReport, recorder } from "./helpers/dry-run"
import { generateKeyPairSync, constants, privateDecrypt, createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { isFinalSubmit } from "../src/engine/test-mode"
import { BESTBUY_PAUSE, createBestBuyModule } from "../src/stores/bestbuy"
import { encryptBestBuyPan } from "../src/stores/bestbuy/card"
import { decodeQueueSeconds, monitorUrl, parseSku, readStock } from "../src/stores/bestbuy/parse"
import type { StoreRunContext } from "../src/stores/module"

const instore = readFileSync(new URL("./fixtures/bestbuy-instore.json", import.meta.url), "utf8")
const marketplace = readFileSync(new URL("./fixtures/bestbuy-marketplace.json", import.meta.url), "utf8")
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString()

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
  store: "bestbuy",
  label: "Main",
  username: "ada@example.com",
  session: { accessToken: "bb-token", visitorId: "visitor-9", cookie: "at=bb-token; vt=visitor-9" }
}

const productUrl = "https://www.bestbuy.com/product/pokemon-trading-card-game-scarlet-violet-prismatic-evolutions-elite-trainer-box/JJG2TLCW3L/sku/6606082"

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
    task: { id: "t1", sku: productUrl, quantity: 1, store: "bestbuy" },
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

function shippable(price = 49.99, regular = 49.99, button = "ADD_TO_CART"): string {
  return JSON.stringify({
    data: {
      productBySkuId: {
        skuId: "6606082",
        name: { short: "Pokémon Trading Card Game: Scarlet & Violet - Prismatic Evolutions Elite Trainer Box" },
        seller: { classification: "1P", id: "bby", name: "Best Buy" },
        price: { customerPrice: price, regularPrice: regular },
        fulfillmentOptions: {
          buttonStates: [{ buttonState: button, condition: "NEW", displayText: "Add to Cart" }],
          shippingDetails: [{ shippingAvailability: [{ condition: "NEW", shippingEligible: true }] }]
        }
      }
    }
  })
}

function orderPage(shippingEligible = true): string {
  return `<html><script>var orderData = ${JSON.stringify({
    id: "order-1",
    payment: { id: "pay-1" },
    userOrderId: "user-9",
    items: [{ id: "item-1", meta: { fulfillmentEligibilities: { shippingEligible } } }]
  })};</script></html>`
}

function cartBody(): unknown {
  return {
    cartCount: 1,
    cartSubTotal: 49.99,
    summaryItems: [{ skuId: "6606082", priceDetails: { totalCustomerPrice: 49.99 } }]
  }
}

function queueCode(seconds: number, sku: string): string {
  const marker = "ab12"
  let hashed = Buffer.from(`${seconds}${marker}${sku}`)
  hashed = createHash("sha256").update(hashed).digest()
  return `001${marker}${hashed.toString("hex")}`
}

function happy(req: HttpRequest, placeBody: unknown = { status: "submitted", userOrderId: "BBY100" }, stock = shippable()): HttpResponse {
  const url = req.url
  if (url.includes("/cart/json")) return json(200, { cartCount: 0 })
  if (url.includes("/sku/6606082") || url.includes("searchpage")) return json(200, stock)
  if (url.includes("/addToCart")) return json(200, cartBody())
  if (url.includes("/cart/checkout")) return json(200, { ok: true })
  if (url.includes("/checkout/r/fast-track")) return json(200, orderPage())
  if (url.includes("preLookup")) return json(200, { threeDSReferenceId: "ref-1", paymentId: "pay-1" })
  if (url.includes("/key/tas")) return json(200, { publicKey: publicPem, keyId: "tas-1" })
  if (url.includes("/creditCard")) return json(200, { creditCard: { number: "masked" } })
  if (url.includes("refreshPayments")) return json(200, {})
  if (req.method === "PATCH") return json(200, {})
  if (req.method === "POST" && url.includes("/checkout/v3/order-1")) return json(200, placeBody)
  return json(500, `unexpected ${req.method} ${url}`)
}

describe("best buy stock parser", () => {
  it("reads a SKU from a bare id or a product URL", () => {
    expect(parseSku("6606082")).toBe("6606082")
    expect(parseSku("12771570")).toBe("12771570")
    expect(parseSku(productUrl)).toBe("6606082")
    expect(parseSku("https://www.bestbuy.com/site/6606082.p?skuId=6606082")).toBe("6606082")
    expect(parseSku("not-a-sku")).toBeNull()
    expect(monitorUrl(productUrl, "6606082")).toBe(productUrl)
    expect(monitorUrl("6606082", "6606082")).toBe("https://www.bestbuy.com/site/searchpage.jsp?st=6606082")
  })

  it("treats the live Best Buy Prismatic SKU as in-store only", () => {
    expect(readStock(instore, "6606082")).toMatchObject({
      inStock: false,
      status: "NO_SHIPPING",
      sku: "6606082",
      seller: "Best Buy",
      price: 49.99
    })
    const wrapped = `<html><script>${instore}</script></html>`
    expect(readStock(wrapped, "6606082")?.status).toBe("NO_SHIPPING")
  })

  it("ignores a live marketplace listing that can ship", () => {
    expect(readStock(marketplace, "12771570")).toMatchObject({
      inStock: false,
      status: "MARKETPLACE",
      price: 159.99
    })
    expect(readStock(marketplace, "6606082")).toMatchObject({ inStock: false, status: "NOT_FOUND" })
  })

  it("accepts Best Buy ship-to-home at the regular price and rejects a higher price", () => {
    expect(readStock(shippable(), "6606082")).toMatchObject({ inStock: true, status: "IN_STOCK", price: 49.99, msrp: 49.99 })
    expect(readStock(shippable(49.99, 49.99, "PRE_ORDER"), "6606082")).toMatchObject({ inStock: true, status: "IN_STOCK" })
    expect(readStock(shippable(89.99, 49.99), "6606082")).toMatchObject({ inStock: false, status: "ABOVE_MSRP", price: 89.99, msrp: 49.99 })
  })

  it("decodes a constrained-item queue code", () => {
    expect(decodeQueueSeconds(queueCode(12, "6606082"), "6606082")).toBe(12)
  })
})

describe("best buy module", () => {
  it("monitors, waits out the add-to-cart queue, and checks out shipping only", async () => {
    const code = queueCode(4, "6606082")
    let carts = 0
    const sleeps: number[] = []
    const fake = client((req) => {
      if (req.url.includes("/addToCart")) {
        carts += 1
        if (carts === 1) {
          return json(400, { errorCode: "CONSTRAINED_ITEM" }, {
            a2ctransactioncode: code,
            a2ctransactionreferenceid: "ref-queue",
            a2ctransactionwait: "4"
          })
        }
        expect(req.headers?.a2ctransactioncode).toBe(code)
        expect(req.headers?.a2ctransactionreferenceid).toBe("ref-queue")
        return json(200, cartBody())
      }
      return happy(req)
    })
    const result = await createBestBuyModule().run(ctx(fake.http, { sleep: async (ms) => { sleeps.push(ms) } }))
    expect(result).toMatchObject({ outcome: "success", orderId: "BBY100" })
    expect(sleeps).toContain(4000)
    expect(carts).toBe(2)
    const page = fake.calls.find((call) => call.url.includes("/sku/6606082"))
    expect(page?.headers?.cookie).toBe("at=bb-token; vt=visitor-9")
    const atc = fake.calls.find((call) => call.url.includes("/addToCart"))
    expect(JSON.parse(atc?.body ?? "{}").items[0]).toMatchObject({ skuId: "6606082", quantity: 1 })
    const checkout = fake.calls.find((call) => call.url.includes("/cart/checkout"))
    expect(JSON.parse(checkout?.body ?? "{}")).toMatchObject({
      productTotal: "49,99",
      subTotal: 49.99,
      cartItems: [{ sku: "6606082", totalCustomerPrice: "$49.99", isDigital: false }]
    })
    const ship = fake.calls.find((call) => call.method === "PATCH")
    expect(new URL(ship?.url ?? "https://invalid").pathname).toBe("/checkout/v3/order-1")
    expect(JSON.parse(ship?.body ?? "{}").items[0].fulfillment.type).toBe("shipping")
    expect(JSON.parse(ship?.body ?? "{}").items[0].fulfillment.address).toMatchObject({
      addressLine1: "1 Main St",
      city: "New York",
      postalCode: "10001",
      saveToProfile: false
    })
    const key = fake.calls.find((call) => call.url.includes("/key/tas"))
    expect(key?.method).toBe("GET")
    expect(key?.body ?? "").not.toContain("4242424242424242")
    const pay = fake.calls.find((call) => call.url.includes("/creditCard"))
    expect(pay?.method).toBe("PUT")
    expect(new URL(pay?.url ?? "https://invalid").hostname).toBe("www.bestbuy.com")
    const card = JSON.parse(pay?.body ?? "{}").creditCard
    expect(card.cvv).toBe("123")
    expect(card.binNumber).toBe("424242")
    expect(pay?.body ?? "").not.toContain("4242424242424242")
    const plain = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
      Buffer.from(card.number, "base64")
    )
    expect(plain.toString()).toBe("009600014242424242424242")
    expect(fake.calls.some((call) => call.url.includes("cardinalcommerce") || call.url.includes("pickup"))).toBe(false)
    const place = fake.calls.find((call) => isFinalSubmit("bestbuy", call))
    const placeBody = JSON.parse(place?.body ?? "{}")
    expect(placeBody.metadata.userDeviceDetails).toBeUndefined()
    expect(placeBody.metadata.browserInfo).toBeUndefined()
    expect(fake.calls.filter((call) => isFinalSubmit("bestbuy", call))).toHaveLength(1)
  })

  it("uses SKU search for a bare SKU because the legacy product link drops it", async () => {
    const fake = client((req) => {
      if (req.url.includes("searchpage")) return json(403, "<html>access denied</html>")
      if (req.url.includes("/cart/json")) return json(200, {})
      return json(500, "should not run")
    })
    const result = await createBestBuyModule().run(ctx(fake.http, {
      task: { id: "t1", sku: "6606082", quantity: 1, store: "bestbuy" }
    }))
    expect(result).toMatchObject({ outcome: "paused", reason: BESTBUY_PAUSE })
    expect(fake.calls.some((call) => call.url === "https://www.bestbuy.com/site/searchpage.jsp?st=6606082")).toBe(true)
    expect(fake.calls.some((call) => call.url.includes("/addToCart"))).toBe(false)
  })

  it("keeps watching a marketplace listing until Best Buy can ship it", async () => {
    let checks = 0
    const fake = client((req) => {
      if (req.url.includes("/sku/6606082")) {
        checks += 1
        return json(200, checks === 1 ? marketplace.replaceAll("12771570", "6606082") : shippable())
      }
      return happy(req)
    })
    let slept = 0
    const result = await createBestBuyModule().run(ctx(fake.http, { sleep: async () => { slept += 1 } }))
    expect(result.outcome).toBe("success")
    expect(checks).toBe(2)
    expect(slept).toBeGreaterThan(0)
  })

  it("does not buy the live in-store-only Best Buy listing", async () => {
    let checks = 0
    const fake = client((req) => {
      if (req.url.includes("/sku/6606082")) {
        checks += 1
        return json(200, checks === 1 ? instore : shippable())
      }
      return happy(req)
    })
    const result = await createBestBuyModule().run(ctx(fake.http))
    expect(result.outcome).toBe("success")
    expect(checks).toBe(2)
    expect(fake.calls.filter((call) => call.url.includes("/addToCart"))).toHaveLength(1)
  })

  it("pauses on an Akamai block before add to cart or payment", async () => {
    const fake = client((req) => {
      if (req.url.includes("/sku/6606082")) return json(403, "<html><title>Access Denied</title>akamai</html>")
      if (req.url.includes("/cart/json")) return json(200, {})
      return json(500, "should not run")
    })
    const result = await createBestBuyModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "paused", reason: BESTBUY_PAUSE })
    expect(fake.calls.some((call) => call.url.includes("/addToCart"))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("/creditCard"))).toBe(false)
  })

  it("pauses before any request when the account has no session", async () => {
    const fake = client(() => json(500, "should not run"))
    const result = await createBestBuyModule().run(ctx(fake.http, { account: { ...account, session: undefined } }))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(result.reason).toMatch(/cookie header/)
    expect(fake.calls).toHaveLength(0)
  })

  it("pauses a guest cart instead of checking out signed-out", async () => {
    const fake = client((req) => req.url.includes("/cart/json") ? json(200, { authStatus: "G", cartItemCount: "0" }) : json(500, "no"))
    const result = await createBestBuyModule().run(ctx(fake.http))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(result.reason).toMatch(/not signed in/)
    expect(fake.calls).toHaveLength(1)
  })

  it("refuses a pickup-only checkout", async () => {
    const fake = client((req) => {
      if (req.url.includes("/checkout/r/fast-track")) return json(200, orderPage(false))
      return happy(req)
    })
    const result = await createBestBuyModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    if (result.outcome === "failed") expect(result.reason).toMatch(/does not place pickup/)
    expect(fake.calls.some((call) => call.url.includes("/creditCard"))).toBe(false)
  })

  it("pauses when checkout asks for 3-D Secure and does not call the card network", async () => {
    const fake = client((req) => happy(req, { errors: [{ errorCode: "PAY_SECURE_REDIRECT", paySecureResponse: { stepUpJwt: "jwt" } }] }))
    const result = await createBestBuyModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "paused", reason: BESTBUY_PAUSE })
    expect(fake.calls.some((call) => call.url.includes("cardinalcommerce"))).toBe(false)
  })

  it("reports a declined card without claiming an order", async () => {
    const fake = client((req) => happy(req, { status: "failed", errors: [{ message: "PAYMENT_DECLINED" }] }))
    const result = await createBestBuyModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    if (result.outcome === "failed") expect(result.reason).toMatch(/declined/i)
  })

  it("does not retry place order when Best Buy reports unavailable stock", async () => {
    const fake = client((req) => isFinalSubmit("bestbuy", req)
      ? json(409, { error: "Out of stock" })
      : happy(req))
    const result = await createBestBuyModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    expect(fake.calls.filter((call) => isFinalSubmit("bestbuy", call))).toHaveLength(1)
  })

  it("waits on a numeric please-wait header for a high-velocity queue", async () => {
    let carts = 0
    const sleeps: number[] = []
    const fake = client((req) => {
      if (req.url.includes("/addToCart")) {
        carts += 1
        if (carts === 1) return json(429, { errorCode: "CONSTRAINED_ITEM_DHV" }, { a2ctransactionwait: "7", a2ctransactionreferenceid: "dhv-1" })
        return json(200, cartBody())
      }
      return happy(req)
    })
    const result = await createBestBuyModule().run(ctx(fake.http, { sleep: async (ms) => { sleeps.push(ms) } }))
    expect(result.outcome).toBe("success")
    expect(sleeps).toContain(7000)
  })

  it("runs payment and never sends place order in test mode", async () => {
    const fake = client((req) => happy(req))
    const rec = recorder()
    const result = await createBestBuyModule().run(ctx(fake.http, { testMode: true, ...rec.part }))
    expectDryRunReport(rec, result, { stages: ["monitor","cart","place"], cart: "left" })
    expect(result.outcome).toBe("tested")
    expect(fake.calls.some((call) => call.url.includes("/creditCard") || (call.body ?? "").includes("creditCard"))).toBe(true)
    expect(fake.calls.some((call) => isFinalSubmit("bestbuy", call))).toBe(false)
  })
})

describe("best buy card encryption", () => {
  it("RSA-OAEP encrypts the Best Buy PAN prefix", () => {
    const encoded = encryptBestBuyPan("4242 4242 4242 4242", publicPem)
    const plain = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
      Buffer.from(encoded, "base64")
    )
    expect(plain.toString()).toBe("009600014242424242424242")
    expect(encoded).not.toContain("4242424242424242")
  })
})
