import { describe, expect, it } from "vitest"
import { classifyChallenge } from "../src/engine/challenge"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { parseListings } from "../src/engine/listings"
import { isFinalSubmit } from "../src/engine/test-mode"
import { recommendedModule } from "../src/shared/module-settings"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import type { StoreRunContext } from "../src/stores/module"
import { createTcgplayerModule, TCGPLAYER_PAUSE } from "../src/stores/tcgplayer"
import { chooseListings, listingsBody, parseProductId, productPageUrl, readListings } from "../src/stores/tcgplayer/parse"

const pan = "4242424242424242"
const id = "509980"
const page = `https://www.tcgplayer.com/product/${id}/charizard-ex`

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

const account: FullAccount = {
  id: "a1",
  store: "tcgplayer",
  label: "Main",
  username: "ada@example.com",
  session: { accessToken: "session", cookie: "sid=signed-in" }
}

const details = { productId: 509980, productName: "Charizard ex - 223/197", marketPrice: 94.4, listings: 304 }
const direct = {
  results: [{ totalResults: 1, results: [{ listingId: 11, price: 90.5, quantity: 2, sellerName: "Shop", directSeller: true, directListing: true, directInventory: 1 }] }]
}
const marketplace = {
  results: [{ totalResults: 67, results: [{ listingId: 12, price: 80, quantity: 3, sellerName: "Other", directSeller: true, directListing: false, directInventory: 0 }] }]
}

function response(status: number, body: unknown): HttpResponse {
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
    task: { id: "t1", sku: page, quantity: 1, store: "tcgplayer" },
    profile,
    account,
    settings: { ...DEFAULT_SETTINGS, monitorDelayMs: 1000 },
    module: recommendedModule("tcgplayer"),
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

function catalog(req: HttpRequest, listed: unknown = direct): HttpResponse {
  if (req.url.endsWith("/details")) return response(200, details)
  if (req.url.endsWith("/listings")) return response(200, listed)
  if (req.url.includes("/checkout") || req.url.includes("place-order")) return response(200, { orderId: "SHOULD-NOT-RUN" })
  return response(404, { error: "unexpected" })
}

describe("tcgplayer catalog", () => {
  it("reads a product URL and treats only Direct inventory as retailer stock", () => {
    expect(parseProductId(page)).toBe(id)
    expect(parseProductId(id)).toBe(id)
    expect(parseProductId("https://example.com/product/509980")).toBeNull()
    expect(productPageUrl(id)).toBe(`https://www.tcgplayer.com/product/${id}`)
    const rows = readListings(JSON.stringify(direct))
    expect(chooseListings(rows, "retailer")).toHaveLength(1)
    const enrolled = readListings(JSON.stringify(marketplace))
    expect(chooseListings(enrolled, "retailer")).toHaveLength(0)
    expect(chooseListings(enrolled, "any")).toHaveLength(1)
    const listings = parseListings("tcgplayer", JSON.stringify({ results: [{ results: [{ productId: 509980, productName: "Charizard ex", marketPrice: 94.4 }] }] }))
    expect(listings[0]?.sku).toBe(id)
    expect(listings[0]?.sellerKnown).toBe(false)
  })
})

describe("tcgplayer direct", () => {
  it("reads the public catalog without a session and does not post a cart or order", async () => {
    const fake = client((req) => catalog(req))
    const result = await createTcgplayerModule().run(ctx(fake.http, { account: { ...account, session: undefined } }))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") {
      expect(result.reason).toContain("did not add it to the cart")
      expect(classifyChallenge(result.reason)).toBe(false)
    }
    expect(fake.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /v1/product/509980/details",
      "POST /v1/product/509980/listings"
    ])
    expect(new Set(fake.calls.map((call) => new URL(call.url).hostname))).toEqual(new Set(["mp-search-api.tcgplayer.com"]))
    expect(fake.calls.some((call) => isFinalSubmit("tcgplayer", call))).toBe(false)
    expect(fake.calls.some((call) => /cart|checkout|place-order/i.test(call.url))).toBe(false)
    const posted = fake.calls.find((call) => call.method === "POST")
    expect(JSON.parse(posted?.body ?? "{}").filters.term.directSeller).toBe(true)
    expect(posted?.body ?? "").not.toContain(pan)
  })

  it("finishes test mode from the catalog and never calls place-order", async () => {
    const fake = client((req) => catalog(req))
    const result = await createTcgplayerModule().run(ctx(fake.http, { testMode: true }))
    expect(result.outcome).toBe("tested")
    expect(fake.calls.some((call) => isFinalSubmit("tcgplayer", call))).toBe(false)
    expect(fake.calls.some((call) => call.url.includes("/checkout/place-order"))).toBe(false)
  })

  it("does not call a Direct-enrolled seller stock when Direct inventory is zero", async () => {
    const controller = new AbortController()
    const detailsSeen: string[] = []
    const fake = client((req) => catalog(req, marketplace))
    const result = await createTcgplayerModule().run(ctx(fake.http, {
      signal: controller.signal,
      detail: (message) => detailsSeen.push(message),
      sleep: async () => controller.abort()
    }))
    expect(result.outcome).toBe("stopped")
    expect(detailsSeen.some((line) => line.includes("no TCGplayer Direct listing"))).toBe(true)
    expect(fake.calls.some((call) => call.method === "POST" && /cart|checkout/i.test(call.url))).toBe(false)
  })

  it("counts any listing with quantity when sold-by is any", async () => {
    const fake = client((req) => catalog(req, marketplace))
    const result = await createTcgplayerModule().run(ctx(fake.http, {
      module: { ...recommendedModule("tcgplayer"), soldBy: "any" }
    }))
    expect(result.outcome).toBe("paused")
    const posted = fake.calls.find((call) => call.method === "POST")
    expect(JSON.parse(posted?.body ?? "{}")).toEqual(JSON.parse(listingsBody(false)))
    expect(posted?.body ?? "").not.toContain("directSeller")
  })

  it("pauses on a catalog challenge before listings", async () => {
    const fake = client(() => response(403, "<html>Attention Required. are-you-human</html>"))
    const result = await createTcgplayerModule().run(ctx(fake.http, { account: { ...account, session: undefined } }))
    expect(result).toEqual({ outcome: "paused", reason: TCGPLAYER_PAUSE })
    expect(classifyChallenge(TCGPLAYER_PAUSE)).toBe(true)
    expect(fake.calls.some((call) => call.url.endsWith("/listings"))).toBe(false)
  })
})
