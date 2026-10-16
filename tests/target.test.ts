import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { createTargetModule, TARGET_PAUSE } from "../src/stores/target"
import { createRegistry } from "../src/stores/registry"
import type { StoreRunContext } from "../src/stores/module"

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
  store: "target",
  label: "Main",
  username: "ada@example.com",
  session: { accessToken: "token-1", visitorId: "visitor-1", refreshToken: "refresh-1" }
}

function json(status: number, body: unknown, headers: HttpResponse["headers"] = {}): HttpResponse {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function stock(status: string) {
  return {
    data: {
      product_summaries: [{
        item: { product_description: { title: "Pokemon ETB" } },
        fulfillment: { sold_out: false, shipping_options: { availability_status: status } }
      }]
    }
  }
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
  const logs: string[] = []
  return {
    task: { id: "t1", sku: "https://www.target.com/p/pokemon-etb/-/A-88897904", quantity: 2, store: "target" },
    profile,
    account,
    settings: { ...DEFAULT_SETTINGS, monitorDelayMs: 1000 },
    signal: new AbortController().signal,
    http,
    log: (_level, message) => logs.push(message),
    detail: () => undefined,
    phase: () => undefined,
    sleep: async () => undefined,
    onSession: async () => undefined,
    ...overrides
  }
}

function happy(req: HttpRequest, checkoutBody: unknown = { orders: [{ order_id: "100200300" }] }): HttpResponse {
  const url = req.url
  if (url.includes("product_summary_with_fulfillment")) return json(200, stock("IN_STOCK"))
  if (url.includes("/v1/cart_items/") && req.method === "PUT") return json(200, { cart_id: "cart-1" })
  if (url.includes("/v1/cart_items") && req.method === "POST") return json(201, { cart_id: "cart-1", cart_item_id: "item-1" })
  if (url.includes("cart_shipping_addresses")) return json(201, { cart_id: "cart-1" })
  if (url.includes("payment_instructions")) return json(201, { ok: true })
  if (url.includes("/v1/checkout")) return json(200, checkoutBody)
  if (url.includes("/v1/cart")) return json(200, { cart_id: "cart-1" })
  return json(500, `unexpected ${req.method} ${url}`)
}

describe("target module", () => {
  it("monitors, adds to cart, and checks out shipping only", async () => {
    const fake = client((req) => happy(req))
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "success", orderId: "100200300" })
    const atc = fake.calls.find((call) => call.url.includes("/v1/cart_items") && call.method === "POST")
    expect(JSON.parse(atc?.body ?? "{}")).toMatchObject({
      cart_item: { tcin: "88897904", quantity: 2 }
    })
    const ship = fake.calls.find((call) => call.url.includes("cart_shipping_addresses"))
    expect(JSON.parse(ship?.body ?? "{}").address).toMatchObject({
      address_type: "SHIPPING",
      address_line1: "1 Main St",
      city: "New York"
    })
    const pay = fake.calls.find((call) => call.url.includes("payment_instructions"))
    expect(new URL(pay?.url ?? "https://invalid").hostname).toBe("carts.target.com")
    expect(JSON.parse(pay?.body ?? "{}").card_details.card_number).toBe("4242424242424242")
    expect(JSON.parse(pay?.body ?? "{}").billing_address.address_line1).toBe("9 Billing Rd")
    const cardCalls = fake.calls.filter((call) => (call.body ?? "").includes("4242424242424242"))
    expect(cardCalls.length).toBeGreaterThan(0)
    expect(cardCalls.every((call) => new URL(call.url).hostname === "carts.target.com")).toBe(true)
    expect(fake.calls.some((call) => call.url.includes("cart_pickup"))).toBe(false)
  })

  it("pauses on a monitor challenge before touching the cart", async () => {
    const fake = client((req) => {
      if (req.url.includes("product_summary") || req.url.includes("pdp_fulfillment")) {
        return json(403, "<html>captcha</html>")
      }
      if (req.url.includes("/v1/cart?")) return json(200, { cart_id: "cart-1" })
      return json(500, "should not run")
    })
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(result.reason).toBe(TARGET_PAUSE)
    expect(fake.calls.some((call) => call.url.includes("cart_items"))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("payment_instructions"))).toBe(false)
  })

  it("returns to the monitor when the first read is out of stock", async () => {
    let checks = 0
    const fake = client((req) => {
      if (req.url.includes("product_summary_with_fulfillment")) {
        checks += 1
        return json(200, stock(checks === 1 ? "OUT_OF_STOCK" : "IN_STOCK"))
      }
      return happy(req)
    })
    let slept = 0
    const result = await createTargetModule().run(ctx(fake.http, { sleep: async () => { slept += 1 } }))
    expect(result.outcome).toBe("success")
    expect(slept).toBeGreaterThan(0)
    expect(checks).toBe(2)
  })

  it("reports a declined card without claiming an order", async () => {
    const fake = client((req) => happy(req, { error: "PAYMENT_DECLINED_EXCEPTION" }))
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    if (result.outcome === "failed") expect(result.reason).toMatch(/declined/i)
  })

  it("resubmits CVV when checkout asks for it", async () => {
    let checkouts = 0
    const fake = client((req) => {
      if (req.url.includes("/v1/checkout")) {
        checkouts += 1
        if (checkouts === 1) return json(400, 'MISSING_CREDIT_CARD_CVV Missing CVV or PIN code on payment instruction pay-9')
        return json(200, { orders: [{ order_id: "555" }] })
      }
      return happy(req)
    })
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "success", orderId: "555" })
    const cvv = fake.calls.find((call) => call.method === "PUT" && call.url.includes("payment_instructions/pay-9"))
    expect(JSON.parse(cvv?.body ?? "{}").card_details.cvv).toBe("123")
    expect(new URL(cvv?.url ?? "https://invalid").hostname).toBe("carts.target.com")
  })
})

describe("store registry", () => {
  it("implements Target, Walmart, and Best Buy and stubs the other retailers", async () => {
    const registry = createRegistry()
    expect([...registry.keys()].sort()).toEqual(["amazon", "bestbuy", "crunchyroll", "pokemon-center", "target", "walmart"])
    expect(registry.get("target")?.implemented).toBe(true)
    expect(registry.get("walmart")?.implemented).toBe(true)
    expect(registry.get("walmart")?.skuHint).toBe("Item ID or product URL")
    expect(registry.get("bestbuy")?.implemented).toBe(true)
    expect(registry.get("bestbuy")?.skuHint).toBe("SKU or product URL")
    for (const id of ["pokemon-center", "amazon", "crunchyroll"] as const) {
      const result = await registry.get(id)?.run(ctx({ async request() { return json(500, "no") } }))
      expect(registry.get(id)?.implemented).toBe(false)
      expect(result?.outcome).toBe("failed")
    }
  })
})
