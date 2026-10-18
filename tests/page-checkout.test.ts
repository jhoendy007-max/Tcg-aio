import { describe, expect, it } from "vitest"
import { classifyChallenge } from "../src/engine/challenge"
import { storeProbe } from "../src/engine/health"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { isFinalSubmit } from "../src/engine/test-mode"
import { MODULE_RATE_FLOOR, moduleCheckoutNote, recommendedModule } from "../src/shared/module-settings"
import { taskText } from "../src/shared/task-role"
import { DEFAULT_SETTINGS, STORE_IDS, type FullAccount, type FullProfile, type StoreId } from "../src/shared/types"
import { createBarnesNobleModule } from "../src/stores/barnes-noble"
import { createCostcoModule } from "../src/stores/costco"
import { createGameStopModule } from "../src/stores/gamestop"
import type { StoreModule, StoreRunContext } from "../src/stores/module"
import { pageHandoff } from "../src/stores/page/run"
import { createSamsModule } from "../src/stores/sams"

const pan = "4242424242424242"
const clientId = "11111111-2222-4333-8444-555555555555"

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

function account(store: StoreId): FullAccount {
  return { id: "a1", store, label: "Main", username: "ada@example.com", session: { accessToken: "session", cookie: "sid=signed-in" } }
}

const modules: { id: StoreId; sku: string; module: StoreModule; host: string; place: string }[] = [
  { id: "gamestop", sku: "https://www.gamestop.com/toys-games/trading-cards/products/pokemon-day-2026/436435.html", module: createGameStopModule(), host: "www.gamestop.com", place: "/on/demandware.store/Sites-gamestop-us-Site/default/CheckoutServices-PlaceOrder" },
  { id: "barnes-noble", sku: "https://www.barnesandnoble.com/w/pokemon-handbook/9781465481234", module: createBarnesNobleModule(), host: "www.barnesandnoble.com", place: "/checkout/api/place-order" },
  { id: "costco", sku: "https://www.costco.com/pokemon.product.100000001.html", module: createCostcoModule(), host: "www.costco.com", place: "/ebusiness/order/v1/orders/place" },
  { id: "sams", sku: "https://www.samsclub.com/ip/pokemon-etb/980000001", module: createSamsModule(), host: "www.samsclub.com", place: "/checkout/placeorder" }
]

function json(status: number, body: string, headers: HttpResponse["headers"] = {}): HttpResponse {
  return { status, headers, body }
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

function page(inner: string): string {
  return `<!doctype html><html><head><script type="application/ld+json">{"@type":"Product","name":"Pokemon Day 2026","offers":{"@type":"Offer","price":"49.99","availability":"https://schema.org/InStock"}}</script></head><body>${inner}</body></html>`
}

function cartForm(host: string): string {
  return page(`<form action="https://${host}/cart/add" method="post"><input type="hidden" name="csrf_token" value="csrf-cart"><input type="hidden" name="pid" value=""><input type="hidden" name="quantity" value="1"><input type="hidden" name="client_id" value="${clientId}"><button type="submit">Add to Cart</button></form><form action="https://ecom-api.costco.com/ebusiness/order/v1/orders/place" method="post"><input name="pid" value="1"><button type="submit">Add to Cart</button></form>`)
}

function addressForm(host: string): string {
  return page(`<form action="https://${host}/checkout/address" method="post"><input type="hidden" name="csrf_token" value="csrf-address"><input name="firstName"><input name="lastName"><input name="address1"><input name="city"><input name="state"><input name="postalCode"><button type="submit">Continue</button></form>`)
}

function shippingForm(host: string): string {
  return page(`<form action="https://${host}/checkout/shipping" method="post"><input type="hidden" name="csrf_token" value="csrf-ship"><input type="radio" name="shippingMethod" value="store"> Store pickup<input type="radio" name="shippingMethod" value="ground"> Ground<button type="submit">Continue</button></form>`)
}

function paymentForm(host: string): string {
  return page(`<form action="https://${host}/checkout/payment" method="post"><input type="hidden" name="csrf_token" value="csrf-pay"><input type="radio" name="savedCard" value="card-1"> Visa 4242<button type="submit">Continue</button></form>`)
}

function tokenForm(host: string): string {
  return page(`<form action="https://${host}/checkout/tokenize" method="post"><input type="hidden" name="csrf_token" value="csrf-token"><input name="cardNumber"><input name="cvv"><input name="expirationMonth"><input name="expirationYear"><button type="submit">Save card</button></form>`)
}

function placeForm(host: string, place: string): string {
  return page(`<form action="https://${host}${place}" method="post"><input type="hidden" name="csrf_token" value="csrf-place"><button type="submit">Place order</button></form>`)
}

function scripted(entry: (typeof modules)[number], mode: "saved" | "token" | "none" | "oos" | "challenge"): (req: HttpRequest) => HttpResponse {
  const productPath = new URL(entry.sku).pathname
  return (req) => {
    const url = new URL(req.url)
    if (url.hostname !== entry.host) return json(500, "off-host")
    if (req.method === "GET" && url.pathname === productPath) return json(200, cartForm(entry.host))
    if (url.pathname === "/cart/add") {
      if (mode === "oos") return json(200, "sold out")
      if (mode === "challenge") return json(403, "<html><body>Just a moment... verifying your connection</body></html>")
      return json(200, addressForm(entry.host))
    }
    if (url.pathname === "/checkout/address") return json(200, shippingForm(entry.host))
    if (url.pathname === "/checkout/shipping") {
      if (mode === "token") return json(200, tokenForm(entry.host))
      if (mode === "none") return json(200, page(`<form action="https://${entry.host}/search" method="get"><input name="q"></form>`))
      return json(200, paymentForm(entry.host))
    }
    if (url.pathname === "/checkout/payment" || url.pathname === "/checkout/tokenize") return json(200, placeForm(entry.host, entry.place))
    if (url.pathname === entry.place) return json(200, JSON.stringify({ orderId: "ORD-1" }))
    return json(404, `unexpected ${url.pathname}`)
  }
}

describe("page store checkout", () => {
  it("walks the store's own forms and stops before place order in test mode", async () => {
    for (const entry of modules) {
      const fake = client(scripted(entry, "saved"))
      const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http, { testMode: true }))
      expect(result.outcome, entry.id).toBe("tested")
      expect(fake.calls.some((call) => isFinalSubmit(entry.id, call)), entry.id).toBe(false)
      expect(fake.calls.some((call) => call.url.includes(entry.place)), entry.id).toBe(false)
      expect(new Set(fake.calls.map((call) => new URL(call.url).hostname)), entry.id).toEqual(new Set([entry.host]))
      expect(fake.calls.some((call) => call.url.includes("ecom-api")), entry.id).toBe(false)
      const bodies = fake.calls.map((call) => call.body ?? "").join("\n")
      expect(bodies, entry.id).not.toContain(pan)
      expect(bodies, entry.id).not.toContain(clientId)
      const cart = fake.calls.find((call) => call.url.endsWith("/cart/add"))
      expect(cart?.method, entry.id).toBe("POST")
      expect(cart?.headers?.cookie, entry.id).toContain("sid=signed-in")
      const cartBody = new URLSearchParams(cart?.body ?? "")
      expect(cartBody.get("csrf_token"), entry.id).toBe("csrf-cart")
      expect(cartBody.get("quantity"), entry.id).toBe("1")
      const address = new URLSearchParams(fake.calls.find((call) => call.url.endsWith("/checkout/address"))?.body ?? "")
      expect(address.get("firstName"), entry.id).toBe("Ada")
      expect(address.get("postalCode"), entry.id).toBe("10001")
      expect(address.get("state"), entry.id).toBe("NY")
      const shipping = new URLSearchParams(fake.calls.find((call) => call.url.endsWith("/checkout/shipping"))?.body ?? "")
      expect(shipping.get("shippingMethod"), entry.id).toBe("ground")
      const payment = new URLSearchParams(fake.calls.find((call) => call.url.endsWith("/checkout/payment"))?.body ?? "")
      expect(payment.get("savedCard"), entry.id).toBe("card-1")
      expect(payment.get("cardNumber"), entry.id).toBeNull()
    }
  })

  it("places the order only when the page's place form is submitted", async () => {
    for (const entry of modules) {
      const fake = client(scripted(entry, "saved"))
      const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http))
      expect(result, entry.id).toMatchObject({ outcome: "success", orderId: "ORD-1" })
      const place = fake.calls.find((call) => isFinalSubmit(entry.id, call))
      expect(place?.method, entry.id).toBe("POST")
      expect(new URL(place?.url ?? "").pathname, entry.id).toBe(entry.place)
      expect(place?.body ?? "", entry.id).not.toContain(pan)
      expect(fake.calls.filter((call) => isFinalSubmit(entry.id, call)), entry.id).toHaveLength(1)
    }
  })

  it("does not retry a final order request after a rate-limit response", async () => {
    for (const entry of modules) {
      let submits = 0
      const fake = client((req) => {
        if (isFinalSubmit(entry.id, req)) {
          submits += 1
          return json(429, "rate limited")
        }
        return scripted(entry, "saved")(req)
      })
      const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http))
      expect(result.outcome, entry.id).toBe("failed")
      expect(submits, entry.id).toBe(1)
    }
  })

  it("sends the card only to the tokenization form the page linked", async () => {
    const entry = modules[0]
    const fake = client(scripted(entry, "token"))
    const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http, { testMode: true }))
    expect(result.outcome).toBe("tested")
    const token = fake.calls.find((call) => call.url.endsWith("/checkout/tokenize"))
    expect(token?.body ?? "").toContain(pan)
    const others = fake.calls.filter((call) => !call.url.endsWith("/checkout/tokenize")).map((call) => call.body ?? "").join("\n")
    expect(others).not.toContain(pan)
    expect(fake.calls.some((call) => isFinalSubmit(entry.id, call))).toBe(false)
  })

  it("does not send the card when the page has neither a saved card nor a token form", async () => {
    const entry = modules[1]
    const fake = client(scripted(entry, "none"))
    const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") {
      expect(result.reason).toMatch(/card number was not sent/i)
      expect(classifyChallenge(result.reason)).toBe(false)
    }
    expect(fake.calls.some((call) => isFinalSubmit(entry.id, call))).toBe(false)
    expect(fake.calls.map((call) => call.body ?? "").join("\n")).not.toContain(pan)
  })

  it("pauses on a challenge response and does not continue checkout", async () => {
    const entry = modules[3]
    const fake = client(scripted(entry, "challenge"))
    const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(classifyChallenge(result.reason)).toBe(true)
    expect(fake.calls.some((call) => call.url.includes("/checkout/"))).toBe(false)
    expect(fake.calls.some((call) => isFinalSubmit(entry.id, call))).toBe(false)
  })

  it("returns to the monitor when add to cart says the item is gone", async () => {
    const entry = modules[0]
    const controller = new AbortController()
    const fake = client(scripted(entry, "oos"))
    const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http, {
      signal: controller.signal,
      sleep: async () => controller.abort()
    }))
    expect(result.outcome).toBe("stopped")
    expect(fake.calls.filter((call) => call.method === "POST")).toHaveLength(1)
    expect(fake.calls.some((call) => isFinalSubmit(entry.id, call))).toBe(false)
  })

  it("does not cart when the page price is above the task max", async () => {
    const entry = modules[2]
    const fake = client(scripted(entry, "saved"))
    const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http, { task: { id: "t1", sku: entry.sku, quantity: 1, store: entry.id, maxPrice: 10 } }))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(result.reason).toContain("$10.00")
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true)
    expect(fake.calls.some((call) => call.url.includes("ecom-api"))).toBe(false)
  })

  it("does not cart when a configured max price has no verified product price", async () => {
    const entry = modules[0]
    const fake = client((req) => req.method === "GET" && new URL(req.url).pathname === new URL(entry.sku).pathname
      ? json(200, `<html><body><form action="https://${entry.host}/cart/add" method="post"><button>Add to Cart</button></form></body></html>`)
      : scripted(entry, "saved")(req))
    const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http, {
      task: { id: "t1", sku: entry.sku, quantity: 1, store: entry.id, maxPrice: 40 }
    }))
    expect(result).toMatchObject({ outcome: "paused" })
    if (result.outcome === "paused") expect(result.reason).toMatch(/verified price is required/i)
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true)
  })

  it("does not cart when the spend check refuses", async () => {
    const entry = modules[0]
    const fake = client(scripted(entry, "saved"))
    const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http, {
      spendCheck: () => ({ ok: false, reason: "Daily budget is $1.00. Today's spend would be $49.99." })
    }))
    expect(result).toMatchObject({ outcome: "paused" })
    if (result.outcome === "paused") expect(result.reason).toContain("Daily budget")
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true)
  })

  it("keeps a monitor task from posting even when the page has a cart form", async () => {
    const entry = modules[0]
    const controller = new AbortController()
    const fake = client(scripted(entry, "saved"))
    const result = await entry.module.run(runCtx(entry.id, entry.sku, fake.http, {
      monitorOnly: true,
      signal: controller.signal,
      sleep: async () => controller.abort()
    }))
    expect(result.outcome).toBe("stopped")
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true)
  })

  it("ignores an off-host form and a Costco ecom-api action", async () => {
    const evil = client(() => json(200, page(`<form action="https://evil.example/cart/add" method="post"><button type="submit">Add to Cart</button></form>`)))
    const paused = await createGameStopModule().run(runCtx("gamestop", modules[0].sku, evil.http))
    expect(paused.outcome).toBe("paused")
    if (paused.outcome === "paused") expect(paused.reason).toBe(pageHandoff("Pokemon Day 2026"))
    expect(evil.calls.every((call) => call.method === "GET")).toBe(true)

    const costco = client(() => json(200, page(`<script>var clientId="${clientId}"</script><form action="https://ecom-api.costco.com/ebusiness/order/v1/orders/place" method="post"><input name="client_id" value="${clientId}"><button type="submit">Add to Cart</button></form>`)))
    const refused = await createCostcoModule().run(runCtx("costco", modules[2].sku, costco.http))
    expect(refused.outcome).toBe("paused")
    expect(costco.calls.some((call) => call.url.includes("ecom-api"))).toBe(false)
    expect(costco.calls.map((call) => call.body ?? "").join("\n")).not.toContain(clientId)
  })

  it("uses the Spanish handoff when the language is Spanish", async () => {
    const fake = client(() => json(200, page("<button type=\"submit\">Add to Cart</button>")))
    const result = await createGameStopModule().run(runCtx("gamestop", modules[0].sku, fake.http, {
      settings: { ...DEFAULT_SETTINGS, language: "es", monitorDelayMs: 1000 }
    }))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") {
      expect(result.reason).toContain("no lo añadió")
      expect(classifyChallenge(result.reason)).toBe(false)
    }
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true)
  })

  it("keeps recommended defaults and read-only health probes for the five stores", () => {
    for (const id of ["gamestop", "barnes-noble", "costco", "sams", "tcgplayer"] as const) {
      const recommended = recommendedModule(id)
      expect(recommended.rateLimitMs).toBe(MODULE_RATE_FLOOR[id])
      expect(recommended.atcMode).toBe("standard")
      expect(recommended.soldBy).toBe("retailer")
      expect(recommended.monitorDelayMs).toBeGreaterThanOrEqual(3000)
      expect(recommended.retryDelayMs).toBeGreaterThan(recommended.monitorDelayMs)
      const probe = storeProbe(id)
      expect(probe.startsWith("https://")).toBe(true)
      expect(probe).not.toMatch(/cart|checkout|place-order|ecom-api/i)
    }
    expect(storeProbe("tcgplayer")).toContain("mp-search-api.tcgplayer.com/v1/product/")
    expect(storeProbe("costco")).toContain("https://www.costco.com/")
    expect(moduleCheckoutNote("en", "gamestop")).toMatch(/form/i)
    expect(moduleCheckoutNote("es", "costco")).toMatch(/ecom-api/)
    expect(moduleCheckoutNote("en", "tcgplayer")).toMatch(/catalog/i)
    expect(moduleCheckoutNote("es", "tcgplayer")).toMatch(/sesión/)
    expect(moduleCheckoutNote("en", "target")).toBe("")
    expect(taskText("en", "healthTitle")).toBe("Store health check")
    expect(taskText("es", "healthHint")).toMatch(/carrito/)
    expect(taskText("en", "healthRun")).toMatch(/health/i)
    for (const id of STORE_IDS) expect(storeProbe(id).includes("ecom-api")).toBe(false)
  })
})
