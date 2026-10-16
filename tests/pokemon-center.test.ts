import { createDecipheriv, createPrivateKey, constants, generateKeyPairSync, privateDecrypt } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { POKEMON_CENTER_PAUSE, createPokemonCenterModule } from "../src/stores/pokemon-center"
import { cardType, createCardJwe, readFlexContext, readPaymentToken } from "../src/stores/pokemon-center/card"
import { isChallenge, parseSku, productUrl, readQueueTarget, readStock, searchUrl } from "../src/stores/pokemon-center/parse"
import type { StoreRunContext } from "../src/stores/module"

const datadomeHtml = readFileSync(new URL("./fixtures/pokemoncenter-datadome.html", import.meta.url), "utf8")
const datadomeJson = readFileSync(new URL("./fixtures/pokemoncenter-datadome.json", import.meta.url), "utf8")
const incapsulaHtml = readFileSync(new URL("./fixtures/pokemoncenter-incapsula.html", import.meta.url), "utf8")
const impervaJson = readFileSync(new URL("./fixtures/pokemoncenter-imperva.json", import.meta.url), "utf8")
const impervaIframe = readFileSync(new URL("./fixtures/pokemoncenter-imperva-iframe.html", import.meta.url), "utf8")

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const jwk = publicKey.export({ format: "jwk" })
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()

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
  store: "pokemon-center",
  label: "Main",
  username: "ada@example.com",
  session: { accessToken: "session", cookie: "GlobalE_Consent=1; datadome=abc" }
}

const sku = "10-10416-112"
const productPage = `https://www.pokemoncenter.com/product/${sku}/pokemon-tcg-mega-evolution-pitch-black-pokemon-center-elite-trainer-box`
const pan = "4242424242424242"

function json(status: number, body: unknown, headers: Record<string, string | string[]> = {}): HttpResponse {
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
    task: { id: "t1", sku: productPage, quantity: 1, store: "pokemon-center" },
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

function jwt(payload: unknown): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

function captureJwt(origin = "https://flex.cybersource.com", path = "/flex/v2/tokens"): string {
  return jwt({
    flx: {
      origin,
      path,
      jwk: { kty: "RSA", kid: "flex-kid", n: jwk.n, e: jwk.e, alg: "RSA-OAEP" }
    }
  })
}

function productHtml(status = "IN_STOCK", productUri = "/cart/add/10-10416-112"): string {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: {
      initialState: {
        product: {
          pid: sku,
          title: "Pokémon TCG: Mega Evolution Pitch Black Elite Trainer Box",
          availability_status: status,
          price: 49.99,
          addToCartForm: productUri
        }
      }
    }
  })}</script></html>`
}

function searchDoc(status: string, pid = sku): unknown {
  return {
    response: {
      docs: [{
        pid,
        title: "Pokémon TCG: Mega Evolution Pitch Black Elite Trainer Box",
        availability_status: status,
        price: 49.99,
        url: `/product/${pid}/pokemon-tcg-mega-evolution-pitch-black-pokemon-center-elite-trainer-box`
      }]
    }
  }
}

function methods(): unknown {
  return {
    shippingMethods: [
      { id: "bopis", name: "Store Pickup", type: "PICKUP" },
      { id: "std", name: "Standard Shipping", type: "SHIPPING" }
    ]
  }
}

function happy(req: HttpRequest, order: unknown = { orderId: "PC100" }, stock: unknown = productHtml()): HttpResponse {
  const url = req.url
  if (url.includes("/cart?format=nodatalinks") && req.method === "GET") return json(200, { authenticated: true })
  if (url.includes("/product/") || url.includes("/tpci-ecommweb-api/search")) return json(200, stock)
  if (url.includes("/cart?type=product")) return json(200, { cartCount: 1 })
  if (url.includes("/shipping-address")) return json(200, {})
  if (url.includes("/shipping-methods")) return json(200, methods())
  if (url.includes("/shipping-method")) return json(200, { ok: true })
  if (url.includes("/get-payment-iframe-key")) return json(200, { keyId: captureJwt() })
  if (url.includes("flex.cybersource.com")) return json(200, jwt({ jti: "pay-token-1" }))
  if (url.includes("/tpci-ecommweb-api/order")) return json(200, order)
  throw new Error(`unexpected ${req.method} ${url}`)
}

function decryptJwe(jwe: string): { data: { CARD: { number: string; securityCode: string; type: string; expirationMonth: string; expirationYear: string } }; context: string; index: number } {
  const [header, encryptedKey, iv, ciphertext, tag] = jwe.split(".")
  const cek = privateDecrypt(
    { key: createPrivateKey(privatePem), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    Buffer.from(encryptedKey, "base64url")
  )
  const decipher = createDecipheriv("aes-256-gcm", cek, Buffer.from(iv, "base64url"))
  decipher.setAAD(Buffer.from(header))
  decipher.setAuthTag(Buffer.from(tag, "base64url"))
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()])
  return JSON.parse(plain.toString("utf8"))
}

describe("pokémon center parser", () => {
  it("reads a SKU from a bare id or a product URL", () => {
    expect(parseSku(sku)).toBe(sku)
    expect(parseSku("699-85207")).toBe("699-85207")
    expect(parseSku(productPage)).toBe(sku)
    expect(parseSku("https://www.pokemoncenter.com/product/290-85466/pokemon-tcg-scarlet-and-violet-151-pokemon-center-elite-trainer-box")).toBe("290-85466")
    expect(parseSku("not-a-sku")).toBeNull()
    expect(productUrl(productPage, sku)).toBe(productPage)
    expect(searchUrl("699-85207")).toContain("q=699-85207")
    expect(new URL(searchUrl(sku)).hostname).toBe("www.pokemoncenter.com")
  })

  it("reads stock from __NEXT_DATA__ and from search docs", () => {
    expect(readStock(productHtml(), sku)).toMatchObject({ inStock: true, availability: "IN_STOCK", productUri: "/cart/add/10-10416-112", price: 49.99 })
    expect(readStock(productHtml("SOLD_OUT"), sku)?.inStock).toBe(false)
    expect(readStock(productHtml("PRE-ORDER"), sku)).toMatchObject({ inStock: true, availability: "PRE_ORDER" })
    expect(readStock(productHtml("LOW_STOCK"), sku)?.inStock).toBe(true)
    expect(readStock(productHtml("COMING_SOON"), sku)?.inStock).toBe(false)
    expect(readStock(JSON.stringify(searchDoc("AVAILABLE")), sku)).toMatchObject({ inStock: true, availability: "AVAILABLE" })
    expect(readStock(JSON.stringify(searchDoc("OUT_OF_STOCK")), sku)?.inStock).toBe(false)
    expect(readStock(JSON.stringify(searchDoc("IN_STOCK", "290-85466")), sku)?.status).toBe("NOT_FOUND")
  })

  it("treats the live DataDome and Incapsula bodies as challenges and a queue page as a line", () => {
    expect(isChallenge(403, datadomeHtml)).toBe(true)
    expect(isChallenge(403, datadomeJson)).toBe(true)
    expect(isChallenge(200, incapsulaHtml)).toBe(true)
    expect(isChallenge(403, impervaJson)).toBe(true)
    expect(isChallenge(403, impervaIframe)).toBe(true)
    expect(isChallenge(200, productHtml())).toBe(false)
    const queuePage = `<html>Please wait. customerId: "pokemoncenter" eventId: "drop1" targetUrl: "https://www.pokemoncenter.com/" https://pokemoncenter.queue-it.net/</html>`
    expect(isChallenge(200, queuePage)).toBe(false)
    expect(readQueueTarget(200, queuePage, "")).toMatchObject({ host: "pokemoncenter.queue-it.net", customerId: "pokemoncenter", eventId: "drop1" })
    expect(readQueueTarget(302, "", "https://pokemoncenter.queue-it.net/?c=pokemoncenter&e=drop1&t=https%3A%2F%2Fwww.pokemoncenter.com%2F")).toMatchObject({
      customerId: "pokemoncenter",
      eventId: "drop1"
    })
  })
})

describe("pokémon center flex card", () => {
  it("encrypts the card as a Flex JWE and refuses any other token host", () => {
    const capture = captureJwt()
    const jwe = createCardJwe(capture, { number: pan, securityCode: "123", expirationMonth: "12", expirationYear: "2030" })
    expect(jwe.split(".")).toHaveLength(5)
    expect(decryptJwe(jwe)).toMatchObject({
      data: { CARD: { number: pan, securityCode: "123", type: "001", expirationMonth: "12", expirationYear: "2030" } },
      context: capture,
      index: 0
    })
    expect(cardType("378282246310005")).toBe("003")
    expect(cardType("5555555555554444")).toBe("002")
    expect(cardType("6011111111111117")).toBe("004")
    expect(readPaymentToken(jwt({ jti: "pay-token-1" }))).toBe("pay-token-1")
    expect(readFlexContext(capture).tokenUrl).toBe("https://flex.cybersource.com/flex/v2/tokens")
    expect(() => readFlexContext(captureJwt("https://evil.example", "/tokens"))).toThrow(/flex\.cybersource\.com/)
  })
})

describe("pokémon center checkout", () => {
  it("checks out ship-to-home and sends the card only to CyberSource Flex", async () => {
    const fake = client((req) => happy(req))
    const result = await createPokemonCenterModule().run(ctx(fake.http, { task: { id: "t1", sku: productPage, quantity: 2, store: "pokemon-center" } }))
    expect(result).toMatchObject({ outcome: "success", orderId: "PC100" })
    const hosts = fake.calls.map((call) => new URL(call.url).hostname)
    expect(hosts.filter((host) => host !== "www.pokemoncenter.com" && host !== "flex.cybersource.com")).toEqual([])
    const flex = fake.calls.filter((call) => call.url.includes("flex.cybersource.com"))
    expect(flex).toHaveLength(1)
    expect(flex[0]?.headers?.["content-type"]).toBe("application/jwt; charset=utf-8")
    expect(decryptJwe(flex[0]?.body ?? "").data.CARD.number).toBe(pan)
    const key = fake.calls.find((call) => call.url.includes("get-payment-iframe-key"))
    expect(key?.method).toBe("GET")
    expect(key?.body).toBeUndefined()
    expect(key?.url).toContain("microform=true")
    expect(key?.url).not.toContain(pan)
    const order = fake.calls.find((call) => call.url.includes("/tpci-ecommweb-api/order"))
    const orderBody = order?.body ?? ""
    expect(orderBody).not.toContain(pan)
    expect(orderBody).not.toContain("123")
    expect(JSON.parse(orderBody)).toMatchObject({ paymentKey: captureJwt(), paymentToken: "pay-token-1", email: "ada@example.com" })
    const atc = fake.calls.find((call) => call.url.includes("type=product"))
    expect(JSON.parse(atc?.body ?? "{}")).toMatchObject({ productURI: "/cart/add/10-10416-112", quantity: 2 })
    const address = fake.calls.find((call) => call.url.includes("shipping-address"))
    expect(JSON.parse(address?.body ?? "{}")).toMatchObject({ address1: "1 Main St", postalCode: "10001", isDefault: false })
    expect(address?.body).not.toContain("9 Billing Rd")
    const method = fake.calls.find((call) => call.url.includes("/cart/shipping-method?"))
    expect(JSON.parse(method?.body ?? "{}")).toEqual({ shippingMethodId: "std" })
    expect(fake.calls.some((call) => call.url.includes(pan))).toBe(false)
  })

  it("monitors a bare SKU through the search API until it is available", async () => {
    let checks = 0
    const fake = client((req) => {
      if (req.url.includes("/tpci-ecommweb-api/search")) {
        checks += 1
        return json(200, searchDoc(checks === 1 ? "OUT_OF_STOCK" : "IN_STOCK"))
      }
      return happy(req, { orderNumber: "PC200" }, searchDoc("IN_STOCK"))
    })
    let slept = 0
    const result = await createPokemonCenterModule().run(ctx(fake.http, {
      task: { id: "t1", sku, quantity: 1, store: "pokemon-center" },
      sleep: async () => { slept += 1 }
    }))
    expect(result).toMatchObject({ outcome: "success", orderId: "PC200" })
    expect(checks).toBe(2)
    expect(slept).toBeGreaterThan(0)
    expect(fake.calls.some((call) => call.url.includes("/tpci-ecommweb-api/search") && call.url.includes("q=10-10416-112"))).toBe(true)
  })

  it("waits in the Queue-it line, logs the position, then continues", async () => {
    let polls = 0
    const logs: string[] = []
    const fake = client((req) => {
      if (req.url.includes("/enqueue")) return json(200, { queueId: "q-1" })
      if (req.url.includes("/status")) {
        polls += 1
        if (polls === 1) return json(200, { ticket: { usersInLineAheadOfYou: "12", queueNumber: "40" }, updateInterval: 5000 })
        return json(200, { redirectUrl: `${productPage}?queueittoken=abc`, isRedirectToTarget: true }, { "set-cookie": "QueueITAccepted=yes; Path=/" })
      }
      if (req.url.includes("queueittoken")) return json(200, "<html>ok</html>", { "set-cookie": ["QueueITAccepted=yes; Path=/"] })
      if (req.url === productPage && req.method === "GET" && polls === 0) {
        return json(302, "", { location: "https://pokemoncenter.queue-it.net/?c=pokemoncenter&e=drop1&t=https%3A%2F%2Fwww.pokemoncenter.com%2F" })
      }
      return happy(req)
    })
    const result = await createPokemonCenterModule().run(ctx(fake.http, { log: (_level, message) => logs.push(message) }))
    expect(result).toMatchObject({ outcome: "success", orderId: "PC100" })
    expect(logs.some((line) => line.includes("Ahead of you: 12") && line.includes("Checking again in 5s"))).toBe(true)
    const queueCalls = fake.calls.filter((call) => new URL(call.url).hostname.endsWith(".queue-it.net"))
    expect(queueCalls.length).toBeGreaterThan(0)
    expect(queueCalls.every((call) => !call.body?.includes(pan) && !call.headers?.cookie?.includes("datadome"))).toBe(true)
    expect(fake.calls.some((call) => call.url.startsWith("https://www.pokemoncenter.com/product/") && call.url.includes("queueittoken=abc"))).toBe(true)
  })

  it("pauses when the waiting room asks for a captcha", async () => {
    const fake = client((req) => {
      if (req.url.includes("/cart?format=nodatalinks")) return json(200, { authenticated: true })
      if (req.url.includes("/enqueue")) return json(200, { challengeRequired: true })
      if (req.url.includes("/product/")) return json(302, "", { location: "https://pokemoncenter.queue-it.net/?c=pokemoncenter&e=drop1&t=https%3A%2F%2Fwww.pokemoncenter.com%2F" })
      return json(500, "no")
    })
    const result = await createPokemonCenterModule().run(ctx(fake.http))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(result.reason).toMatch(/captcha/i)
    expect(fake.calls.some((call) => call.url.includes("type=product"))).toBe(false)
  })

  it("pauses on the live DataDome and Incapsula bodies before add to cart", async () => {
    for (const body of [json(403, datadomeHtml), json(403, datadomeJson), json(200, incapsulaHtml), json(403, impervaJson), json(403, impervaIframe)]) {
      const fake = client((req) => {
        if (req.url.includes("/cart?format=nodatalinks")) return json(200, { authenticated: true })
        return body
      })
      const result = await createPokemonCenterModule().run(ctx(fake.http))
      expect(result).toMatchObject({ outcome: "paused", reason: POKEMON_CENTER_PAUSE })
      expect(fake.calls.some((call) => call.url.includes("type=product"))).toBe(false)
    }
  })

  it("makes no requests without a session", async () => {
    const fake = client(() => json(200, {}))
    const result = await createPokemonCenterModule().run(ctx(fake.http, { account: { ...account, session: undefined } }))
    expect(result.outcome).toBe("paused")
    expect(fake.calls).toHaveLength(0)
  })

  it("pauses a guest cart and an expired session", async () => {
    const guest = client(() => json(200, { guest: true }))
    expect((await createPokemonCenterModule().run(ctx(guest.http))).outcome).toBe("paused")
    expect(guest.calls).toHaveLength(1)
    const expired = client(() => json(401, "unauthenticated"))
    const expiredResult = await createPokemonCenterModule().run(ctx(expired.http))
    expect(expiredResult.outcome).toBe("paused")
    if (expiredResult.outcome === "paused") expect(expiredResult.reason).toMatch(/expired/i)
  })

  it("fails pickup-only checkout before payment", async () => {
    const fake = client((req) => {
      if (req.url.includes("/shipping-methods")) return json(200, { shippingMethods: [{ id: "bopis", name: "Pickup", type: "PICKUP" }] })
      return happy(req)
    })
    const result = await createPokemonCenterModule().run(ctx(fake.http))
    expect(result.outcome).toBe("failed")
    if (result.outcome === "failed") expect(result.reason).toMatch(/pickup/i)
    expect(fake.calls.some((call) => call.url.includes("get-payment-iframe-key") || call.url.includes("flex.cybersource.com"))).toBe(false)
  })

  it("reports a declined card without claiming an order", async () => {
    const fake = client((req) => happy(req, { error: "PAYMENT_DECLINED" }))
    const result = await createPokemonCenterModule().run(ctx(fake.http))
    expect(result.outcome).toBe("failed")
    if (result.outcome === "failed") expect(result.reason).toMatch(/declined/i)
  })

  it("returns to the monitor when add to cart is out of stock", async () => {
    let adds = 0
    const fake = client((req) => {
      if (req.url.includes("type=product")) {
        adds += 1
        if (adds === 1) return json(409, { status: "OUT_OF_STOCK" })
      }
      return happy(req)
    })
    const result = await createPokemonCenterModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "success", orderId: "PC100" })
    expect(adds).toBe(2)
  })

  it("does not post the card when the capture context names another host", async () => {
    const fake = client((req) => {
      if (req.url.includes("/get-payment-iframe-key")) return json(200, { keyId: captureJwt("https://evil.example", "/tokens") })
      return happy(req)
    })
    const result = await createPokemonCenterModule().run(ctx(fake.http))
    expect(result.outcome).toBe("failed")
    expect(fake.calls.some((call) => new URL(call.url).hostname === "evil.example")).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("/tpci-ecommweb-api/order"))).toBe(false)
  })
})
