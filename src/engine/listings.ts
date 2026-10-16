import type { Settings, StoreId } from "../shared/types"

export interface Listing {
  store: StoreId
  sku: string
  title: string
  price: number | null
  url: string
  retailer: boolean
  /** False when the search page did not name a seller. Those stay eligible; checkout still checks the offer. */
  sellerKnown: boolean
}

const TARGET_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96"
const CRUNCHYROLL_ORG = "f_ecom_bdgc_prd"

export function listingSearchUrl(store: StoreId, query: string, settings: Pick<Settings, "targetApiKey" | "targetStoreId" | "targetZip" | "targetState">): string {
  const q = encodeURIComponent(query)
  if (store === "target") {
    const key = settings.targetApiKey || TARGET_KEY
    const params = new URLSearchParams({
      key,
      channel: "WEB",
      count: "24",
      keyword: query,
      offset: "0",
      page: `/s/${query}`,
      pricing_store_id: settings.targetStoreId,
      store_id: settings.targetStoreId,
      zip: settings.targetZip,
      state: settings.targetState,
      visitor_id: "tcgaio"
    })
    return `https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?${params.toString()}`
  }
  if (store === "walmart") return `https://www.walmart.com/search?q=${q}`
  if (store === "bestbuy") return `https://www.bestbuy.com/site/searchpage.jsp?st=${q}`
  if (store === "pokemon-center") {
    const params = new URLSearchParams({
      fl: "availability_status,display_price,pid,price,sale_price,title,url",
      q: query,
      rows: "24",
      search_type: "keyword",
      start: "0"
    })
    return `https://www.pokemoncenter.com/tpci-ecommweb-api/search?${params.toString()}`
  }
  if (store === "amazon") return `https://www.amazon.com/s?k=${q}`
  return `https://www.crunchyroll.com/mobify/proxy/api/search/shopper-search/v1/organizations/${CRUNCHYROLL_ORG}/product-search?siteId=CrunchyrollUS&q=${q}`
}

export function isListingBlock(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 412 || status === 418 || status === 429 || status === 435) return true
  const text = body.slice(0, 6000).toLowerCase()
  const markers = ["captcha", "access denied", "just a moment", "px-captcha", "robot check", "pardon our interruption", "verify you are human", "datadome", "challenge-platform"]
  if (!markers.some((marker) => text.includes(marker))) return false
  return !looksLikeCatalog(body)
}

export function parseListings(store: StoreId, body: string): Listing[] {
  const json = extractJson(body)
  const found = new Map<string, Listing>()
  if (json) {
    walk(json, (record) => {
      const listing = take(store, record)
      if (listing && !found.has(listing.sku)) found.set(listing.sku, listing)
    })
  }
  if (store === "amazon") {
    for (const listing of amazonHtml(body)) {
      if (!found.has(listing.sku)) found.set(listing.sku, listing)
    }
  }
  return [...found.values()]
}

function take(store: StoreId, record: Record<string, unknown>): Listing | null {
  if (store === "target") return takeTarget(record)
  if (store === "walmart") return takeWalmart(record)
  if (store === "bestbuy") return takeBestBuy(record)
  if (store === "pokemon-center") return takePokemon(record)
  if (store === "amazon") return takeAmazon(record)
  return takeCrunchyroll(record)
}

function takeTarget(record: Record<string, unknown>): Listing | null {
  const sku = text(record.tcin)
  if (!/^\d{5,10}$/.test(sku)) return null
  const title = titleOf(record)
  if (!title) return null
  return { store: "target", sku, title, price: priceOf(record), url: `https://www.target.com/p/-/A-${sku}`, retailer: true, sellerKnown: true }
}

function takeWalmart(record: Record<string, unknown>): Listing | null {
  const sku = text(record.usItemId ?? record.itemId)
  if (!/^\d{5,12}$/.test(sku)) return null
  const title = titleOf(record)
  if (!title) return null
  const seller = text(record.sellerName ?? record.seller)
  return {
    store: "walmart",
    sku,
    title,
    price: priceOf(record),
    url: `https://www.walmart.com/ip/${sku}`,
    retailer: !seller || /walmart/i.test(seller),
    sellerKnown: Boolean(seller)
  }
}

function takeBestBuy(record: Record<string, unknown>): Listing | null {
  const sku = text(record.skuId ?? record.sku)
  if (!/^\d{6,8}$/.test(sku)) return null
  const title = titleOf(record)
  if (!title) return null
  const seller = text(record.sellerName ?? record.seller)
  const marketplace = record.marketplace === true
  return {
    store: "bestbuy",
    sku,
    title,
    price: priceOf(record),
    url: `https://www.bestbuy.com/site/sku/${sku}`,
    retailer: Boolean(seller) ? /best\s*buy/i.test(seller) : !marketplace,
    sellerKnown: Boolean(seller) || marketplace
  }
}

function takePokemon(record: Record<string, unknown>): Listing | null {
  const sku = text(record.pid ?? record.sku)
  if (!/^\d{2,6}(?:-\d{2,6})+$/.test(sku)) return null
  const title = titleOf(record)
  if (!title) return null
  const availability = text(record.availability_status ?? record.availability).toUpperCase()
  if (availability && !["IN_STOCK", "AVAILABLE", "LOW_STOCK", "PRE_ORDER", "PREORDER"].includes(availability)) return null
  return { store: "pokemon-center", sku, title, price: priceOf(record), url: `https://www.pokemoncenter.com/product/${sku}`, retailer: true, sellerKnown: true }
}

function takeAmazon(record: Record<string, unknown>): Listing | null {
  const sku = text(record.asin).toUpperCase()
  if (!/^[A-Z0-9]{10}$/.test(sku)) return null
  const title = titleOf(record)
  if (!title) return null
  const explicit = record.amazonRetail
  const seller = text(record.seller ?? record.soldBy)
  const known = typeof explicit === "boolean" || Boolean(seller)
  const retailer = typeof explicit === "boolean" ? explicit : /amazon(\.com)?$/i.test(seller) || /^amazon(\.com)?$/i.test(seller)
  return { store: "amazon", sku, title, price: priceOf(record), url: `https://www.amazon.com/dp/${sku}`, retailer, sellerKnown: known }
}

function takeCrunchyroll(record: Record<string, unknown>): Listing | null {
  const productId = text(record.productId)
  const fallback = record.productName ? text(record.id) : ""
  const sku = /^\d{8,14}$/.test(productId) ? productId : fallback
  if (!/^\d{8,14}$/.test(sku)) return null
  const title = titleOf(record)
  if (!title) return null
  return { store: "crunchyroll", sku, title, price: priceOf(record), url: `https://www.crunchyroll.com/store/products/${sku}.html`, retailer: true, sellerKnown: true }
}

function amazonHtml(body: string): Listing[] {
  const out: Listing[] = []
  const re = /data-asin="([A-Z0-9]{10})"/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(body))) {
    const sku = match[1].toUpperCase()
    if (/^0+$/.test(sku)) continue
    const next = body.slice(match.index + 20).search(/data-asin="/i)
    const slice = body.slice(match.index, next > 0 ? match.index + 20 + next : match.index + 12000)
    const titleRaw = slice.match(/a-text-normal"[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? ""
    const title = titleRaw.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().split("$")[0].trim()
    if (title.length < 3) continue
    const priceMatch = slice.match(/a-offscreen">\$(\d+(?:\.\d{2})?)/i) ?? slice.match(/\$(\d+(?:\.\d{2})?)/)
    const soldBy = slice.match(/sold by[^<]{0,80}/i)?.[0] ?? ""
    const sellerKnown = /sold by/i.test(soldBy)
    const retailer = sellerKnown && /amazon/i.test(soldBy)
    out.push({
      store: "amazon",
      sku,
      title: title.slice(0, 180),
      price: priceMatch ? Number(priceMatch[1]) : null,
      url: `https://www.amazon.com/dp/${sku}`,
      retailer,
      sellerKnown
    })
  }
  return out
}

function titleOf(record: Record<string, unknown>): string {
  const direct = text(record.title ?? record.name ?? record.productName ?? record.displayName)
  if (direct) return direct
  const item = asRecord(record.item)
  const description = asRecord(item?.product_description ?? record.product_description)
  return text(description?.title)
}

function priceOf(record: Record<string, unknown>): number | null {
  const candidates = [
    record.price,
    record.current_retail,
    record.sale_price,
    record.salePrice,
    record.customerPrice,
    record.display_price,
    asRecord(record.price)?.current_retail,
    asRecord(record.price)?.currentPrice,
    asRecord(asRecord(record.priceInfo)?.currentPrice)?.price,
    asRecord(record.priceInfo)?.currentPrice
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return Math.round(candidate * 100) / 100
    if (typeof candidate === "string") {
      const match = candidate.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/)
      if (match) return Math.round(Number(match[1]) * 100) / 100
    }
  }
  return null
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function extractJson(body: string): unknown {
  const trimmed = body.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return null
    }
  }
  const next = body.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!next) return null
  try {
    return JSON.parse(next[1])
  } catch {
    return null
  }
}

function looksLikeCatalog(body: string): boolean {
  const sample = body.slice(0, 4000).toLowerCase()
  return ["tcin", "usitemid", "skuid", "\"pid\"", "data-asin", "productid", "productname"].some((marker) => sample.includes(marker))
}

function walk(node: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  const record = asRecord(node)
  if (!record) return
  visit(record)
  for (const value of Object.values(record)) walk(value, visit)
}
