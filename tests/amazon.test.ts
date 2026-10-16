import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile } from "../src/shared/types"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { isFinalSubmit } from "../src/engine/test-mode"
import { AMAZON_PAUSE, createAmazonModule } from "../src/stores/amazon"
import { isChallenge, parseAsin, readOffers, readStock } from "../src/stores/amazon/parse"
import type { StoreRunContext } from "../src/stores/module"

const thirdParty = readFileSync(new URL("./fixtures/amazon-aod.html", import.meta.url), "utf8")
const robot = readFileSync(new URL("./fixtures/amazon-robot.html", import.meta.url), "utf8")
const asin = "B0C8YN3BY4"
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

const account: FullAccount = {
  id: "a1",
  store: "amazon",
  label: "Main",
  username: "ada@example.com",
  session: { accessToken: "session", cookie: "session-id=132-000; at-main=signed-in" }
}

function json(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
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

function ctx(http: HttpClient, overrides: Partial<StoreRunContext> = {}): StoreRunContext {
  return {
    task: { id: "t1", sku: `https://www.amazon.com/dp/${asin}`, quantity: 1, store: "amazon" },
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

function product(list = "49.99"): string {
  return `<span id="productTitle">Pokemon TCG 151 Elite Trainer Box</span>
    <script>ue_mid = 'ATVPDKIKX0DER'</script>
    List Price: <span>$${list}</span>`
}

function offer(seller: string, ships: string, merchant: string, price: string, fulfilled = "0", id = "offer-amazon"): string {
  return `<div id="aod-offer">
    <span class="apex-pricetopay-accessibility-label"> $${price} </span>
    <span class="a-color-tertiary">Ships from</span>
    <span class="a-size-small a-color-base"> ${ships} </span>
    <div id="aod-offer-soldBy">
      <a aria-label="${seller}. Opens a new page" href="/gp/aag/main?seller=${merchant}&amp;isAmazonFulfilled=${fulfilled}">${seller}</a>
    </div>
    <form class="AodAddToCart" method="post" action="/cart/add-to-cart/ref=aod_dpdsk_new_0">
      <input type="hidden" name="anti-csrftoken-a2z" value="csrf-amazon">
      <input type="hidden" name="items[0.base][asin]" value="${asin}"/>
      <input type="hidden" name="items[0.base][offerListingId]" value="${id}"/>
      <input aria-label="Add to Cart from seller ${seller} and price $${price}">
    </form>
  </div>`
}

function checkout(): string {
  return `<form id="spc-form" method="post" action="/checkout/p/p-1/spc/place-order">
    <input type="hidden" name="anti-csrftoken-a2z" value="csrf-order">
    <input type="hidden" name="purchaseId" value="p-1">
    <div>Ship to the address saved on your account</div>
    <div>Visa ending in 1111</div>
    <input type="submit" name="placeYourOrder1" value="Place your order">
  </form>`
}

function happy(req: HttpRequest, stock = offer("Amazon.com", "Amazon.com", "ATVPDKIKX0DER", "49.99")): HttpResponse {
  const url = req.url
  if (url.includes("/dp/")) return json(200, product())
  if (url.includes("aodAjaxMain")) return json(200, stock)
  if (url.includes("/cart/add-to-cart")) return json(200, "<html>Added to Cart</html>")
  if (url.includes("/checkout/entry/")) return json(200, checkout())
  if (url.includes("/place-order")) return json(200, "Thank you, your order has been placed. 111-2222222-3333333")
  throw new Error(`unexpected ${req.method} ${url}`)
}

describe("amazon parser", () => {
  it("reads an ASIN from a bare id or a product URL", () => {
    expect(parseAsin(asin)).toBe(asin)
    expect(parseAsin(`https://www.amazon.com/Pokemon-Scarlet-Violet-Elite-Trainer/dp/${asin}`)).toBe(asin)
    expect(parseAsin(`https://www.amazon.com/gp/product/${asin}`)).toBe(asin)
    expect(parseAsin("not-an-asin")).toBeNull()
  })

  it("ignores third-party and fulfilled-by-Amazon offers in the live offer shape", () => {
    const offers = readOffers(thirdParty)
    expect(offers.some((offer) => offer.seller.includes("Collectors Expedition"))).toBe(true)
    expect(offers.every((offer) => offer.price === 609.99)).toBe(true)
    expect(offers.some((offer) => offer.amazonRetail)).toBe(false)
    const reading = readStock(product(), thirdParty, asin)
    expect(reading.inStock).toBe(false)
    expect(reading.status).toBe("OUT_OF_STOCK")
    expect(reading.reason).toMatch(/Collectors Expedition/)
    const fba = offer("SSA Cards", "Amazon.com", "A2JROAOLJ147MG", "49.99", "1", "offer-fba")
    expect(readStock(product(), fba, asin).inStock).toBe(false)
    const page = `<script>ue_mid = 'ATVPDKIKX0DER'</script><span id="productTitle">Pokemon</span>
      <input id="merchantID" name="merchantID" value="A2JROAOLJ147MG">
      <a id="sellerProfileTriggerId">SSA Cards</a>
      <span id="apex-pricetopay-accessibility-label"> $609.99 </span>
      <input name="items[0.base][offerListingId]" value="box-offer">
      <div id="availability">Only 13 left in stock - order soon.</div>`
    expect(readStock(page, "", asin)).toMatchObject({ inStock: false, status: "OUT_OF_STOCK" })
  })

  it("accepts an Amazon.com offer at list price and rejects one above it", () => {
    const amazon = offer("Amazon.com", "Amazon.com", "ATVPDKIKX0DER", "49.99")
    expect(readStock(product(), amazon, asin)).toMatchObject({ inStock: true, status: "IN_STOCK", price: 49.99, offerListingId: "offer-amazon" })
    const high = offer("Amazon.com", "Amazon.com", "ATVPDKIKX0DER", "80.00")
    expect(readStock(product("49.99"), high, asin)).toMatchObject({ inStock: false, status: "ABOVE_PRICE" })
  })

  it("treats the robot-check page as a block and a product page as stock", () => {
    expect(isChallenge(200, robot)).toBe(true)
    expect(isChallenge(200, thirdParty)).toBe(false)
    expect(isChallenge(200, product())).toBe(false)
  })
})

describe("amazon checkout", () => {
  it("checks out ship-to-home with the saved account payment and does not send the card", async () => {
    const fake = client((req) => happy(req))
    const result = await createAmazonModule().run(ctx(fake.http, {
      task: { id: "t1", sku: asin, quantity: 2, store: "amazon" }
    }))
    expect(result).toMatchObject({ outcome: "success", orderId: "111-2222222-3333333" })
    const hosts = new Set(fake.calls.map((call) => new URL(call.url).hostname))
    expect([...hosts]).toEqual(["www.amazon.com"])
    const cart = fake.calls.find((call) => call.url.includes("/cart/add-to-cart"))
    expect(cart?.body).toContain("items%5B0.base%5D%5Bquantity%5D=2")
    expect(cart?.body).toContain("offer-amazon")
    expect(cart?.body).toContain(asin)
    const order = fake.calls.find((call) => call.url.includes("/place-order"))
    expect(order?.body).toContain("purchaseId=p-1")
    expect(order?.body).not.toContain(pan)
    const leaked = fake.calls.find((call) => call.body?.includes(pan) || call.body?.includes("card%5Bcvc") || call.body?.includes("1%20Main%20St") || call.body?.includes("1 Main St"))
    expect(leaked?.url ?? "").toBe("")
    expect(fake.calls[0]?.headers?.cookie).toContain("at-main=signed-in")
    expect(fake.calls.some((call) => call.url.includes("aodAjaxMain") && call.url.includes(asin))).toBe(true)
  })

  it("waits while only third-party sellers have the ASIN", async () => {
    let checks = 0
    const fake = client((req) => {
      if (req.url.includes("aodAjaxMain")) {
        checks += 1
        return json(200, checks === 1 ? thirdParty : offer("Amazon.com", "Amazon.com", "ATVPDKIKX0DER", "49.99"))
      }
      return happy(req)
    })
    let slept = 0
    const result = await createAmazonModule().run(ctx(fake.http, { sleep: async () => { slept += 1 } }))
    expect(result).toMatchObject({ outcome: "success", orderId: "111-2222222-3333333" })
    expect(checks).toBe(2)
    expect(slept).toBeGreaterThan(0)
    expect(fake.calls.filter((call) => call.url.includes("/cart/add-to-cart"))).toHaveLength(1)
  })

  it("pauses on a robot check before add to cart", async () => {
    const fake = client(() => json(200, robot))
    const result = await createAmazonModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "paused", reason: AMAZON_PAUSE })
    expect(fake.calls.some((call) => call.url.includes("/cart/"))).toBe(false)
  })

  it("pauses on two-step verification", async () => {
    const fake = client(() => json(302, "", { location: "https://www.amazon.com/ap/cvf/request" }))
    const result = await createAmazonModule().run(ctx(fake.http))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(result.reason).toMatch(/two-step/i)
  })

  it("makes no requests without a signed-in at-main cookie", async () => {
    const missing = client(() => json(200, ""))
    expect((await createAmazonModule().run(ctx(missing.http, { account: { ...account, session: undefined } }))).outcome).toBe("paused")
    expect(missing.calls).toHaveLength(0)
    const guest = client(() => json(200, ""))
    const guestResult = await createAmazonModule().run(ctx(guest.http, {
      account: { ...account, session: { accessToken: "session", cookie: "session-id=132-000; ubid-main=guest" } }
    }))
    expect(guestResult.outcome).toBe("paused")
    expect(guest.calls).toHaveLength(0)
  })

  it("pauses when checkout redirects to sign-in", async () => {
    const fake = client((req) => {
      if (req.url.includes("/checkout/entry/")) return json(302, `<form name="signIn" action="/ap/signin"></form>`, { location: "https://www.amazon.com/ap/signin" })
      return happy(req)
    })
    const result = await createAmazonModule().run(ctx(fake.http))
    expect(result.outcome).toBe("paused")
    if (result.outcome === "paused") expect(result.reason).toMatch(/expired/i)
    expect(fake.calls.some((call) => call.url.includes("/place-order"))).toBe(false)
  })

  it("fails pickup-only checkout before placing the order", async () => {
    const fake = client((req) => {
      if (req.url.includes("/checkout/entry/")) return json(200, "<div>Amazon Hub Locker</div><div>Pickup location</div>")
      return happy(req)
    })
    const result = await createAmazonModule().run(ctx(fake.http))
    expect(result.outcome).toBe("failed")
    if (result.outcome === "failed") expect(result.reason).toMatch(/pickup/i)
    expect(fake.calls.some((call) => call.url.includes("/place-order"))).toBe(false)
  })

  it("does not send the card when Amazon asks for a security code or has no saved payment", async () => {
    const cvv = client((req) => {
      if (req.url.includes("/checkout/entry/")) return json(200, `<div>Visa ending in 1111</div><input name="cvv">`)
      return happy(req)
    })
    const cvvResult = await createAmazonModule().run(ctx(cvv.http))
    expect(cvvResult.outcome).toBe("paused")
    expect(cvv.calls.some((call) => call.body?.includes(pan))).toBe(false)
    const none = client((req) => {
      if (req.url.includes("/checkout/entry/")) return json(200, "<div>Add a credit or debit card</div>")
      return happy(req)
    })
    const noneResult = await createAmazonModule().run(ctx(none.http))
    expect(noneResult.outcome).toBe("failed")
    if (noneResult.outcome === "failed") expect(noneResult.reason).toMatch(/saved payment/i)
    expect(none.calls.some((call) => call.body?.includes(pan) || call.url.includes("/place-order"))).toBe(false)
  })

  it("returns to the monitor when add to cart says the item is unavailable", async () => {
    let carts = 0
    const fake = client((req) => {
      if (req.url.includes("/cart/add-to-cart")) {
        carts += 1
        if (carts === 1) return json(200, "This item is not available")
      }
      return happy(req)
    })
    const result = await createAmazonModule().run(ctx(fake.http))
    expect(result).toMatchObject({ outcome: "success", orderId: "111-2222222-3333333" })
    expect(carts).toBe(2)
  })

  it("reads checkout and never submits place order in test mode", async () => {
    const fake = client((req) => happy(req))
    const result = await createAmazonModule().run(ctx(fake.http, { testMode: true }))
    expect(result.outcome).toBe("tested")
    expect(fake.calls.some((call) => call.url.includes("/checkout/entry/"))).toBe(true)
    expect(fake.calls.some((call) => isFinalSubmit("amazon", call))).toBe(false)
  })
})
