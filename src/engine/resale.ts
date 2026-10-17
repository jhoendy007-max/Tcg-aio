import type { HttpClient } from "./http"
import { detailsUrl, parseProductId, readProduct } from "../stores/tcgplayer/parse"
import type { ResaleQuery, ResaleQuote } from "../shared/types"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export function median(values: number[]): number | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b)
  if (!sorted.length) return null
  const mid = Math.floor(sorted.length / 2)
  const value = sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
  return round(value)
}

/** Sale is a unit price. Cost is the total already paid. Fee percent applies to the sale total. */
export function resaleProfit(unit: number | null, cost: number | null, quantity: number, feePct: number): number | null {
  if (unit === null || cost === null) return null
  const sale = unit * quantity
  const fee = sale * (Math.max(0, feePct) / 100)
  return round(sale - fee - cost)
}

export function readEbaySold(body: string): { prices: number[]; challenge: boolean } {
  if (isPriceChallenge(body)) return { prices: [], challenge: true }
  const prices: number[] = []
  const re = /s-item__price[^$]{0,80}\$(\d{1,6}(?:,\d{3})*(?:\.\d{2})?)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(body)) && prices.length < 60) {
    const value = Number((match[1] ?? "").replace(/,/g, ""))
    if (Number.isFinite(value) && value > 0) prices.push(round(value))
  }
  return { prices, challenge: false }
}

export function readPricepointMarket(body: string): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  for (const row of parsed) {
    if (!row || typeof row !== "object") continue
    const price = (row as { marketPrice?: unknown }).marketPrice
    if (typeof price === "number" && Number.isFinite(price) && price >= 0) return round(price)
  }
  return null
}

export function draftListing(input: { title: string; quantity: number; price: number | null; source: string }): string {
  const title = input.title.trim() || "Untitled"
  const price = input.price === null ? "Set a price after checking sold listings." : `$${input.price.toFixed(2)}`
  const lines = [
    title,
    "Condition: New",
    `Price: ${price}`,
    `Quantity: ${input.quantity}`
  ]
  if (input.source) lines.push(`Price source: ${input.source}`)
  lines.push("", "Draft only. TCGAIO did not post this listing.")
  return lines.join("\n")
}

export async function lookupResale(http: HttpClient, query: ResaleQuery): Promise<ResaleQuote> {
  const title = query.title.trim().slice(0, 180)
  const quantity = Math.max(1, Math.min(12, Math.round(query.quantity || 1)))
  const feePct = Math.max(0, Math.min(40, round(query.feePct || 0)))
  const cost = query.cost === null || !Number.isFinite(query.cost) || query.cost < 0 ? null : round(query.cost)
  const id = parseProductId(query.tcgProductId)
  let tcgMarket: number | null = null
  let tcgNote = id ? "" : "Paste a TCGplayer product id or product URL to load the market price."
  if (id) {
    const details = await readOnly(http, detailsUrl(id), "https://www.tcgplayer.com/")
    if (isPriceChallenge(details.body) || details.status === 403 || details.status === 412) {
      tcgNote = "TCGplayer presented a challenge. The market price was not read."
    } else {
      tcgMarket = readProduct(details.body, id)?.marketPrice ?? null
      if (tcgMarket === null || tcgMarket === undefined) {
        const points = await readOnly(http, `https://mpapi.tcgplayer.com/v2/product/${encodeURIComponent(id)}/pricepoints`, `https://www.tcgplayer.com/product/${id}`)
        if (!isPriceChallenge(points.body) && points.status < 400) tcgMarket = readPricepointMarket(points.body)
      }
      tcgNote = tcgMarket === null ? "The public catalog did not include a market price." : "TCGplayer market price from the public catalog."
    }
  }

  let ebayMedian: number | null = null
  let ebayCount = 0
  let ebayNote = title ? "" : "Enter a product name to search eBay sold listings."
  if (title) {
    const soldUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(title)}&LH_Sold=1&LH_Complete=1&rt=nc&_ipg=60`
    const sold = await readOnly(http, soldUrl, "https://www.ebay.com/")
    const parsed = readEbaySold(sold.body)
    if (parsed.challenge || sold.status === 403 || sold.status === 412) {
      ebayNote = "eBay presented a challenge. Sold prices were not read. TCGAIO does not solve challenges."
    } else {
      ebayMedian = median(parsed.prices)
      ebayCount = parsed.prices.length
      ebayNote = ebayCount
        ? `Median of ${ebayCount} item prices on the public eBay sold search. Shipping is not included.`
        : "The public eBay sold search did not include prices."
    }
  }

  const suggested = ebayMedian ?? tcgMarket
  const source = ebayMedian !== null ? "eBay sold median" : tcgMarket !== null ? "TCGplayer market" : ""
  return {
    title,
    cost,
    quantity,
    feePct,
    tcgMarket,
    tcgNote,
    ebayMedian,
    ebayCount,
    ebayNote,
    tcgProfit: resaleProfit(tcgMarket, cost, quantity, feePct),
    ebayProfit: resaleProfit(ebayMedian, cost, quantity, feePct),
    draft: draftListing({ title, quantity, price: suggested, source }),
    posted: false
  }
}

async function readOnly(http: HttpClient, url: string, referer: string) {
  const host = new URL(url).hostname
  const allowed = host === "mp-search-api.tcgplayer.com" || host === "mpapi.tcgplayer.com" || host === "www.ebay.com"
  if (!allowed) throw new Error(`Refusing to contact ${host}.`)
  return http.request({
    method: "GET",
    url,
    headers: {
      accept: host === "www.ebay.com" ? "text/html" : "application/json",
      "accept-language": "en-US,en;q=0.9",
      referer,
      "user-agent": USER_AGENT
    },
    timeoutMs: 20000
  })
}

function isPriceChallenge(body: string): boolean {
  const sample = body.slice(0, 8000).toLowerCase()
  if (sample.includes("marketprice") || sample.includes("s-item__price")) return false
  return sample.includes("attention required")
    || sample.includes("just a moment")
    || sample.includes("verify you are human")
    || sample.includes("px-captcha")
    || sample.includes("are-you-human")
    || (sample.includes("captcha") && !sample.includes("marketprice"))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}
