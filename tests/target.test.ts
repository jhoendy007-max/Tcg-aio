import { expectDryRunReport, recorder } from "./helpers/dry-run"
import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { isFinalSubmit } from "../src/engine/test-mode"
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

function stock(status: string, price?: number | string) {
  return {
    data: {
      product_summaries: [{
        item: { product_description: { title: "Pokemon ETB" } },
        ...(price === undefined ? {} : { price: { current_retail: price } }),
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

  it("does not add to cart when a configured max price cannot be verified", async () => {
    const fake = client((req) => happy(req))
    const result = await createTargetModule().run(ctx(fake.http, {
      task: { id: "t1", sku: "https://www.target.com/p/pokemon-etb/-/A-88897904", quantity: 2, store: "target", maxPrice: 50 }
    }))
    expect(result).toMatchObject({ outcome: "paused" })
    if (result.outcome === "paused") expect(result.reason).toMatch(/verified price is required/i)
    expect(fake.calls.some((call) => call.url.includes("cart_items"))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("payment_instructions"))).toBe(false)
  })

  it("does not add to cart when Target's price exceeds the configured max", async () => {
    const fake = client((req) => req.url.includes("product_summary_with_fulfillment")
      ? json(200, stock("IN_STOCK", "59.99"))
      : happy(req))
    const result = await createTargetModule().run(ctx(fake.http, {
      task: { id: "t1", sku: "https://www.target.com/p/pokemon-etb/-/A-88897904", quantity: 2, store: "target", maxPrice: 50 }
    }))
    expect(result).toMatchObject({ outcome: "paused" })
    if (result.outcome === "paused") expect(result.reason).toContain("$59.99")
    expect(fake.calls.some((call) => call.url.includes("cart_items"))).toBe(false)
  })

  it("does not invent a visitor id when the saved session has none", async () => {
    const fake = client((req) => happy(req))
    await createTargetModule().run(ctx(fake.http, {
      account: { ...account, session: { accessToken: "token-without-visitor" } }
    }))
    const cart = fake.calls.find((call) => call.method === "POST" && call.url.includes("/cart_items"))
    expect(cart?.headers?.cookie ?? "").not.toMatch(/visitorI[Dd]=/)
    expect(cart?.headers?.authorization).toContain("token-without-visitor")
  })

  it("makes no request when neither a Target session nor password is present", async () => {
    const fake = client(() => json(500, "unexpected request"))
    const result = await createTargetModule().run(ctx(fake.http, {
      account: { ...account, session: undefined }
    }))
    expect(result).toMatchObject({ outcome: "paused" })
    expect(fake.calls).toEqual([])
  })

  it("stops when add to cart fails", async () => {
    const fake = client((req) => req.method === "POST" && req.url.includes("/cart_items")
      ? json(500, "cart unavailable")
      : happy(req))
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    expect(fake.calls.some((call) => call.url.includes("cart_shipping_addresses"))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("payment_instructions"))).toBe(false)
  })

  it("stops when the shipping address is rejected", async () => {
    const fake = client((req) => req.url.includes("cart_shipping_addresses")
      ? json(400, "address.mobile required")
      : happy(req))
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    expect(fake.calls.some((call) => call.url.includes("payment_instructions"))).toBe(false)
    expect(fake.calls.filter((call) => isFinalSubmit("target", call))).toHaveLength(0)
  })

  it("stops when Target rejects payment", async () => {
    const fake = client((req) => req.url.includes("payment_instructions")
      ? json(400, "payment rejected")
      : happy(req))
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    expect(fake.calls.filter((call) => isFinalSubmit("target", call))).toHaveLength(0)
  })

  it("does not retry a failed Target place-order request", async () => {
    let submits = 0
    const fake = client((req) => {
      if (isFinalSubmit("target", req)) {
        submits += 1
        return json(429, "rate limited")
      }
      return happy(req)
    })
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    expect(submits).toBe(1)
  })

  it("does not repeat place order when Target reports an empty cart", async () => {
    let submits = 0
    const fake = client((req) => {
      if (isFinalSubmit("target", req)) {
        submits += 1
        return json(400, { errors: [{ code: "EMPTY_CART_FOR_ORDER_SUBMIT" }] })
      }
      return happy(req)
    })
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    expect(submits).toBe(1)
  })

  it("reports a declined card without claiming an order", async () => {
    const fake = client((req) => happy(req, { error: "PAYMENT_DECLINED_EXCEPTION" }))
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "failed" })
    if (result.outcome === "failed") expect(result.reason).toMatch(/declined/i)
  })

  it("does not retry place order after Target asks for CVV", async () => {
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
    expect(result).toMatchObject({ outcome: "paused" })
    if (result.outcome === "paused") expect(result.reason).toMatch(/did not retry the place-order request/i)
    const cvv = fake.calls.find((call) => call.method === "PUT" && call.url.includes("payment_instructions/pay-9"))
    expect(JSON.parse(cvv?.body ?? "{}").card_details.cvv).toBe("123")
    expect(new URL(cvv?.url ?? "https://invalid").hostname).toBe("carts.target.com")
    expect(fake.calls.filter((call) => isFinalSubmit("target", call))).toHaveLength(1)
  })

  it("runs payment and never sends place order in test mode", async () => {
    const fake = client((req) => happy(req))
    const rec = recorder()
    const result = await createTargetModule().run(ctx(fake.http, { testMode: true, ...rec.part }))
    expectDryRunReport(rec, result, { stages: ["monitor","cart","address","shipping","payment","place"], cart: "left" })
    expect(result.outcome).toBe("tested")
    expect(fake.calls.some((call) => call.url.includes("payment_instructions"))).toBe(true)
    expect(fake.calls.some((call) => isFinalSubmit("target", call))).toBe(false)
  })
})

describe("Dry run cart cleanup (0.2.46)", () => {
  it("removes the test line when the setting is on and reports it, with no leftover warning", async () => {
    const fake = client((req) => happy(req))
    const rec = recorder()
    const result = await createTargetModule().run(ctx(fake.http, { testMode: true, clearCartAfterTest: true, ...rec.part }))
    expectDryRunReport(rec, result, { stages: ["monitor", "cart", "address", "shipping", "payment", "place"], cart: "removed" })
    const removal = fake.calls.filter((call) => call.method === "PUT" && call.url.includes("/cart_items/item-1")).at(-1)
    expect(JSON.parse(removal?.body ?? "{}").cart_item.quantity).toBe(0)
    expect(rec.marks.some((mark) => mark.stage === "cart" && mark.result === "pass" && /removed/i.test(mark.detail))).toBe(true)
  })

  it("says so when the test line could not be removed, and still warns", async () => {
    let puts = 0
    const fake = client((req) => req.method === "PUT" && req.url.includes("/cart_items/item-1") && (puts += 1) > 1 ? json(500, "no") : happy(req))
    const rec = recorder()
    const result = await createTargetModule().run(ctx(fake.http, { testMode: true, clearCartAfterTest: true, ...rec.part }))
    expect(result.outcome).toBe("tested")
    expect(rec.marks.some((mark) => mark.stage === "cart" && mark.result === "fail" && /by hand/i.test(mark.detail))).toBe(true)
    expect(rec.logs.some((entry) => entry.level === "warn" && /still in your cart/i.test(entry.message))).toBe(true)
  })
})

describe("store registry", () => {
  it("implements every catalog store", () => {
    const registry = createRegistry()
    expect([...registry.keys()].sort()).toEqual(["amazon", "bandai", "barnes-noble", "bestbuy", "costco", "crunchyroll", "gamestop", "pokemon-center", "sams", "target", "tcgplayer", "walmart"])
    expect(registry.get("target")?.implemented).toBe(true)
    expect(registry.get("walmart")?.implemented).toBe(true)
    expect(registry.get("walmart")?.skuHint).toBe("Item ID or product URL")
    expect(registry.get("bestbuy")?.implemented).toBe(true)
    expect(registry.get("bestbuy")?.skuHint).toBe("SKU or product URL")
    expect(registry.get("pokemon-center")?.implemented).toBe(true)
    expect(registry.get("pokemon-center")?.skuHint).toBe("SKU or product URL")
    expect(registry.get("crunchyroll")?.implemented).toBe(true)
    expect(registry.get("crunchyroll")?.skuHint).toBe("Product ID or URL")
    expect(registry.get("amazon")?.implemented).toBe(true)
    expect(registry.get("amazon")?.skuHint).toBe("ASIN or product URL")
    expect(registry.get("bandai")?.implemented).toBe(true)
    expect(registry.get("bandai")?.skuHint).toBe("Product code or p-bandai.com item URL")
    expect(registry.get("gamestop")?.skuHint).toBe("Product URL or GameStop product id")
    expect(registry.get("barnes-noble")?.skuHint).toBe("Product URL or ISBN")
    expect(registry.get("costco")?.skuHint).toBe("Product URL or Costco item number")
    expect(registry.get("sams")?.skuHint).toBe("Product URL or Sam's Club item number")
    expect(registry.get("tcgplayer")?.skuHint).toBe("Product id or tcgplayer.com product URL")
    for (const module of registry.values()) expect(module.implemented).toBe(true)
  })
})

describe("target resume after a cleared challenge (0.2.40)", () => {
  it("a challenge at payment pauses with a checkout resume point, and resuming skips monitor and add to cart", async () => {
    let blockPayment = true
    const fake = client((req) => {
      if (req.url.includes("payment_instructions") && blockPayment) return json(403, "<html><div id=\"px-captcha\">Press &amp; Hold</div></html>")
      return happy(req)
    })
    const module = createTargetModule()
    const first = ctx(fake.http)
    const paused = await module.run(first)
    expect(paused).toMatchObject({ outcome: "paused", reason: TARGET_PAUSE, resume: { step: "checkout", cartId: "cart-1", itemId: "item-1" } })

    // A person clears the check; the runner hands back the resume point.
    blockPayment = false
    fake.calls.length = 0
    const resumed = await module.run(ctx(fake.http, { resume: paused.outcome === "paused" ? paused.resume : undefined }))
    expect(resumed).toMatchObject({ outcome: "success", orderId: "100200300" })
    expect(fake.calls.some((call) => call.url.includes("product_summary"))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("/v1/cart_items") && call.method === "POST")).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("payment_instructions"))).toBe(true)
  })

  it("a challenge at add to cart resumes at add to cart without waiting for the monitor", async () => {
    let blockCart = true
    const fake = client((req) => {
      if (req.url.includes("/v1/cart_items") && req.method === "POST" && blockCart) return json(403, "<html>px-captcha</html>")
      return happy(req)
    })
    const module = createTargetModule()
    const paused = await module.run(ctx(fake.http))
    expect(paused).toMatchObject({ outcome: "paused", resume: { step: "cart" } })
    blockCart = false
    fake.calls.length = 0
    const resumed = await module.run(ctx(fake.http, { resume: { step: "cart" } }))
    expect(resumed).toMatchObject({ outcome: "success" })
    expect(fake.calls.some((call) => call.url.includes("product_summary"))).toBe(false)
  })

  it("a monitor challenge has no resume point (the monitor simply starts again)", async () => {
    const fake = client((req) => req.url.includes("product_summary") || req.url.includes("pdp_fulfillment") ? json(403, "<html>captcha</html>") : happy(req))
    const result = await createTargetModule().run(ctx(fake.http))
    expect(result.outcome).toBe("paused")
    expect("resume" in result ? result.resume : undefined).toBeUndefined()
  })
})
