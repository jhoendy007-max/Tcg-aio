const HOSTS = new Set(["tcgplayer.com", "www.tcgplayer.com", "mp-search-api.tcgplayer.com"])

export interface TcgListing {
  listingId: string
  price: number
  quantity: number
  sellerName: string
  direct: boolean
}

export interface TcgProduct {
  id: string
  title: string
  marketPrice?: number
  imageUrl?: string
}

/** Public catalog body. directSeller narrows to Direct-enrolled sellers; stock still requires a Direct listing. */
export function listingsBody(directOnly: boolean): string {
  const term: Record<string, string | number | boolean> = { sellerStatus: "Live", channelId: 0 }
  if (directOnly) term.directSeller = true
  return JSON.stringify({
    filters: {
      term,
      range: { quantity: { gte: 1 } },
      exclude: { channelExclusion: 0 }
    },
    from: 0,
    size: 25,
    sort: { field: "price+shipping", order: "asc" },
    context: { shippingCountry: "US" },
    aggregations: ["listingType"]
  })
}

export function parseProductId(input: string): string | null {
  const text = input.trim()
  if (/^\d{3,12}$/.test(text)) return text
  try {
    const url = new URL(text)
    if (url.protocol !== "https:" || !HOSTS.has(url.hostname.toLowerCase())) return null
    const match = url.pathname.match(/\/product\/(\d{3,12})(?:\/|$)/)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

export function productPageUrl(id: string): string {
  return `https://www.tcgplayer.com/product/${encodeURIComponent(id)}`
}

export function detailsUrl(id: string): string {
  return `https://mp-search-api.tcgplayer.com/v1/product/${encodeURIComponent(id)}/details`
}

export function listingsUrl(id: string): string {
  return `https://mp-search-api.tcgplayer.com/v1/product/${encodeURIComponent(id)}/listings`
}

export function isCatalogChallenge(status: number, body: string): boolean {
  const sample = body.slice(0, 8000).toLowerCase()
  if (sample.includes("productname") || sample.includes("marketprice") || sample.includes("listingid")) return false
  if (sample.includes("verifying your connection") || sample.includes("just a moment") || sample.includes("attention required")) return true
  if (sample.includes("px-captcha") || sample.includes("are-you-human") || sample.includes("verify you are human")) return true
  if (sample.includes("captcha")) return true
  if ((status === 403 || status === 412) && sample.includes("<html")) return true
  return false
}

export function readProduct(body: string, id: string): TcgProduct | null {
  const record = asRecord(safeJson(body))
  if (!record) return null
  const productId = text(record.productId ?? record.id)
  if (productId && productId !== id) return null
  const title = text(record.productName ?? record.name)
  if (!title && !productId) return null
  const market = money(record.marketPrice)
  return { id: productId || id, title, marketPrice: market, imageUrl: httpsImage(record) }
}

export function readListings(body: string): TcgListing[] {
  const rows = listingRows(safeJson(body))
  const found: TcgListing[] = []
  for (const row of rows) {
    const record = asRecord(row)
    if (!record) continue
    const listingId = text(record.listingId)
    const quantity = record.quantity
    const price = money(record.price)
    if (!listingId || typeof quantity !== "number" || quantity < 1 || price === undefined) continue
    const direct = record.directListing === true || (typeof record.directInventory === "number" && record.directInventory > 0)
    found.push({ listingId, price, quantity, sellerName: text(record.sellerName), direct })
  }
  return found
}

/** Direct stock is a listing the catalog marks directListing or directInventory. Enrolled sellers alone are not Direct. */
export function chooseListings(rows: TcgListing[], soldBy: "retailer" | "any"): TcgListing[] {
  const priced = [...rows].sort((a, b) => a.price - b.price)
  if (soldBy === "any") return priced
  return priced.filter((row) => row.direct)
}

function listingRows(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    if (value.some((item) => asRecord(item)?.listingId !== undefined)) return value
    return value.flatMap((item) => listingRows(item))
  }
  const record = asRecord(value)
  if (!record) return []
  if (Array.isArray(record.results)) return listingRows(record.results)
  return []
}

function httpsImage(record: Record<string, unknown>): string | undefined {
  const candidates = [record.imageUrl, record.image, record.tcgImageURL]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^https:\/\/[^\s]+$/.test(candidate) && candidate.length <= 400) return candidate
  }
  return undefined
}

function money(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 100) / 100
  return undefined
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}
