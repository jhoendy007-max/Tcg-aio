import { describe, expect, it } from "vitest"
import type { HttpClient, HttpRequest, HttpResponse } from "../src/engine/http"
import { draftListing, lookupResale, median, readEbaySold, readPricepointMarket, resaleProfit } from "../src/engine/resale"

const details = JSON.stringify({ productId: 509980, productName: "Charizard ex - 223/197", marketPrice: 94.4 })
const points = JSON.stringify([{ printingType: "Holofoil", marketPrice: 88.25, buylistMarketPrice: 50, listedMedianPrice: 90 }])
const soldHtml = `
<div class="s-item__price">$80.00</div>
<div class="s-item__price">$100.00</div>
<div class="s-item__price">$90.00</div>
`
const challenge = "<html><title>Attention Required</title>Just a moment</html>"

function response(status: number, body: string): HttpResponse {
  return { status, headers: {}, body }
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

describe("resale math", () => {
  it("uses the median sold price and subtracts cost and an optional fee", () => {
    expect(median([80, 100, 90])).toBe(90)
    expect(median([10, 20])).toBe(15)
    expect(resaleProfit(90, 40, 1, 0)).toBe(50)
    expect(resaleProfit(90.5, 40, 2, 10)).toBe(122.9)
    expect(resaleProfit(null, 40, 1, 0)).toBeNull()
    expect(resaleProfit(90, null, 1, 0)).toBeNull()
    expect(readEbaySold(soldHtml)).toEqual({ prices: [80, 100, 90], challenge: false })
    expect(readEbaySold(challenge).challenge).toBe(true)
    expect(readEbaySold(challenge).prices).toEqual([])
    expect(readPricepointMarket(points)).toBe(88.25)
    expect(draftListing({ title: "Charizard ex", quantity: 1, price: 90, source: "eBay sold median" })).toContain("TCGAIO did not post this listing.")
  })
})

describe("resale lookup", () => {
  it("reads the public catalog and sold search and does not post a listing", async () => {
    const fake = client((req) => {
      if (req.url.includes("/details")) return response(200, details)
      if (req.url.includes("ebay.com")) return response(200, soldHtml)
      return response(404, "")
    })
    const quote = await lookupResale(fake.http, {
      title: "Charizard ex",
      cost: 40,
      quantity: 1,
      feePct: 0,
      tcgProductId: "https://www.tcgplayer.com/product/509980/charizard-ex"
    })
    expect(quote.posted).toBe(false)
    expect(quote.tcgMarket).toBe(94.4)
    expect(quote.ebayMedian).toBe(90)
    expect(quote.ebayCount).toBe(3)
    expect(quote.tcgProfit).toBe(54.4)
    expect(quote.ebayProfit).toBe(50)
    expect(quote.draft).toContain("Price: $90.00")
    expect(quote.draft).toContain("did not post this listing")
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true)
    expect(fake.calls.some((call) => /cart|checkout|place-order|sell\/v1/i.test(call.url))).toBe(false)
    const hosts = new Set(fake.calls.map((call) => new URL(call.url).hostname))
    expect([...hosts].sort()).toEqual(["mp-search-api.tcgplayer.com", "www.ebay.com"])
  })

  it("falls back to price points and skips sold prices when eBay shows a challenge", async () => {
    const fake = client((req) => {
      if (req.url.includes("/details")) return response(200, JSON.stringify({ productId: 509980, productName: "Charizard ex" }))
      if (req.url.includes("/pricepoints")) return response(200, points)
      return response(403, challenge)
    })
    const quote = await lookupResale(fake.http, { title: "Charizard ex", cost: null, quantity: 1, feePct: 0, tcgProductId: "509980" })
    expect(quote.tcgMarket).toBe(88.25)
    expect(quote.ebayMedian).toBeNull()
    expect(quote.ebayNote).toContain("presented a challenge")
    expect(quote.tcgProfit).toBeNull()
    expect(quote.draft).toContain("Price: $88.25")
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true)
  })

  it("does not call TCGplayer when no product id is entered", async () => {
    const fake = client(() => response(200, soldHtml))
    const quote = await lookupResale(fake.http, { title: "Elite Trainer Box", cost: 30, quantity: 1, feePct: 0, tcgProductId: "" })
    expect(quote.tcgMarket).toBeNull()
    expect(quote.tcgNote).toMatch(/product id/i)
    expect(fake.calls.map((call) => new URL(call.url).hostname)).toEqual(["www.ebay.com"])
  })
})