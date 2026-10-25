import type { StoreId } from "../../shared/types"

export interface PageSpec {
  id: StoreId
  name: string
  skuHint: string
  home: string
  /** The only host this module may request. */
  host: string
  hosts: readonly string[]
  cautiousOutOfStock: boolean
  bare: RegExp
  pathId: RegExp
  canonical: (id: string) => string
  /** What the owner does when this store's cart or checkout page cannot be driven from here. */
  ownerStep: string
}

export interface PageTarget {
  sku: string
  url: string
  /** A specific edition or format asked for (Barnes & Noble ?ean=). */
  variant?: string
}

export type PageAvailability = "IN_STOCK" | "PRE_ORDER" | "UNAVAILABLE"

export type PageFulfillment = "ship" | "pickup" | "unknown"

export interface PageReading {
  inStock: boolean
  status: PageAvailability
  title?: string
  sku: string
  price?: number
  reason: string
  seller: string
  imageUrl?: string
  /** How the page says it can reach the buyer. v1 buys ship-to-home only. */
  fulfillment?: PageFulfillment
  /** Per-account or per-member purchase limit the page states, when it states one. */
  limit?: number
  /** Which part of the page the reading came from. */
  source?: "next-data" | "json-ld" | "page-text"
}

export const GAMESTOP: PageSpec = {
  id: "gamestop",
  name: "GameStop",
  skuHint: "Product URL or GameStop product id",
  home: "https://www.gamestop.com/",
  host: "www.gamestop.com",
  hosts: ["gamestop.com", "www.gamestop.com"],
  cautiousOutOfStock: false,
  bare: /^\d{5,9}$/,
  pathId: /\/(\d{5,9})\.html$/i,
  canonical: (id) => `https://www.gamestop.com/products/${id}.html`,
  ownerStep: "GameStop did not give Zzz AIO a cart form to submit. Add the item and check out in the account window; the stock check, price and session are already done. Dry run stops here."
}

export const BARNES_NOBLE: PageSpec = {
  id: "barnes-noble",
  name: "Barnes & Noble",
  skuHint: "Product URL or ISBN",
  home: "https://www.barnesandnoble.com/",
  host: "www.barnesandnoble.com",
  hosts: ["barnesandnoble.com", "www.barnesandnoble.com"],
  cautiousOutOfStock: false,
  bare: /^(?:\d{9}[\dXx]|\d{10,13})$/,
  pathId: /\/w\/(?:[^/]+\/)?(\d{9}[\dXx]|\d{10,13})\/?$/i,
  canonical: (id) => barnesCanonical(id),
  ownerStep: "Barnes & Noble moved sign-in and checkout to Shopify pages that Zzz AIO does not drive. Add the item and check out in the account window; the stock check, price and session are already done."
}

export const COSTCO: PageSpec = {
  id: "costco",
  name: "Costco",
  skuHint: "Product URL or Costco item number",
  home: "https://www.costco.com/",
  host: "www.costco.com",
  hosts: ["costco.com", "www.costco.com"],
  cautiousOutOfStock: true,
  bare: /^\d{5,12}$/,
  // Costco moved product pages to /p/-/<slug>/<id>; the old .product.<id>.html now 302s there.
  pathId: /(?:\.product\.(\d{5,12})\.html|\/p\/(?:[^/]+\/)*(\d{5,12}))\/?$/i,
  canonical: (id) => `https://www.costco.com/p/-/product/${id}`,
  ownerStep: "Costco's cart and checkout call a separate API with its own keys that Zzz AIO does not use. Add the item and check out in the account window; the stock check, price and session are already done."
}

export const SAMS: PageSpec = {
  id: "sams",
  name: "Sam's Club",
  skuHint: "Product URL or Sam's Club item number",
  home: "https://www.samsclub.com/",
  host: "www.samsclub.com",
  hosts: ["samsclub.com", "www.samsclub.com"],
  cautiousOutOfStock: false,
  bare: /^\d{5,14}$/,
  pathId: /\/ip\/(?:[^/]+\/)?(\d{5,14})\/?$/i,
  canonical: (id) => `https://www.samsclub.com/ip/${id}`,
  ownerStep: "Sam's Club draws its cart and checkout in the page with scripts, so there is no form for Zzz AIO to submit. Add the item and check out in the account window; the stock check, price and session are already done."
}

export const PAGE_SPECS: readonly PageSpec[] = [GAMESTOP, BARNES_NOBLE, COSTCO, SAMS]

export function pageSpec(id: StoreId): PageSpec | undefined {
  return PAGE_SPECS.find((spec) => spec.id === id)
}

export function parsePageTarget(spec: PageSpec, input: string): PageTarget | null {
  const text = input.trim()
  if (!text) return null
  if (spec.bare.test(text)) {
    const sku = normalizeId(text)
    const variant = spec.id === "barnes-noble" ? isbn13(sku) : ""
    return { sku, url: spec.canonical(sku), ...(variant ? { variant } : {}) }
  }
  try {
    const url = new URL(text)
    if (url.protocol !== "https:") return null
    if (!spec.hosts.includes(url.hostname.toLowerCase())) return null
    const match = url.pathname.match(spec.pathId)
    const id = match?.[1] || match?.[2] || ""
    const sku = id ? normalizeId(id) : ""
    if (!sku) return null
    const ean = spec.id === "barnes-noble" ? url.searchParams.get("ean")?.trim() ?? "" : ""
    return { sku, url: `https://${spec.host}${url.pathname}`, ...(/^97[89]\d{10}$/.test(ean) ? { variant: ean } : {}) }
  } catch {
    return null
  }
}

export function parsePageSku(spec: PageSpec, input: string): string | null {
  return parsePageTarget(spec, input)?.sku ?? null
}

/** A challenge page, not a product. The module pauses and a person finishes it. */
export function isPageChallenge(status: number, body: string): boolean {
  const sample = body.slice(0, 12000).toLowerCase()
  if (sample.includes("verifying your connection")) return true
  if (sample.includes("just a moment")) return true
  if (sample.includes("attention required")) return true
  if (sample.includes("px-captcha")) return true
  if (sample.includes("are-you-human")) return true
  if (sample.includes("verify you are human")) return true
  // Sam's Club robot check: "Let us know you're not a robot" / "you're human (no robots allowed)".
  if (/not a robot|you(?:'|’|&#x27;|&#39;)re human|no robots allowed/.test(sample)) return true
  if (sample.includes("captcha") && !sample.includes("application/ld+json")) return true
  if ((status === 403 || status === 412) && !sample.includes('"@type"')) return true
  return false
}

export function isLoginWall(body: string): boolean {
  if (productRecord(body)) return false
  const sample = body.slice(0, 30000).toLowerCase()
  const passwordField = /<input[^>]+type=["']password["']/.test(sample)
  return passwordField && (sample.includes("sign in") || sample.includes("log in"))
}

/**
 * Product-page reading. The order of trust is: the store's own page data (Sam's Club
 * Next.js data), then schema.org JSON-LD (Costco, Barnes & Noble, GameStop), then the page
 * text. InStock, LimitedAvailability, PreOrder, and PreSale are purchasable. A visible Add to
 * Cart control is too. Schema OutOfStock with no add control is not treated as a live warehouse count.
 */
export function readPageOffer(spec: PageSpec, body: string, sku: string, variant?: string): PageReading {
  const next = spec.id === "sams" ? readSamsData(body) : null
  const ld = readJsonLd(body, variant)
  const meta = readMeta(body)
  const add = hasAddControl(body)
  const title = next?.title || ld.title || cleanTitle(meta.title, spec) || undefined
  const price = next?.price ?? ld.price ?? meta.price
  const imageUrl = next?.image || ld.image || meta.image || undefined
  const availability = ld.availability.toLowerCase()

  let source: PageReading["source"] = ld.found ? "json-ld" : "page-text"
  let fulfillment: PageFulfillment = "unknown"
  let schemaBuy = /instock|limitedavailability|pre-?order|pre-?sale/.test(availability)
  let preorder = /pre-?order|pre-?sale/.test(availability) && !/instock|limitedavailability/.test(availability)
  let limit = next?.limit
  let reasonOverride = ""

  if (next) {
    source = "next-data"
    preorder = next.preorder
    if (next.shipping !== undefined) {
      fulfillment = next.shipping ? "ship" : next.pickup ? "pickup" : "unknown"
      schemaBuy = next.shipping
      if (!next.shipping && next.pickup) reasonOverride = `${title || sku} can only be picked up in a club right now. Zzz AIO buys ship-to-home only.`
    } else {
      schemaBuy = next.inStock
      fulfillment = next.inStock ? "ship" : "unknown"
    }
  } else if (schemaBuy) fulfillment = "ship"
  if (!limit && spec.id === "gamestop") limit = readLimit(body)

  // The store's own product data is exact. An "Add to cart" button elsewhere on the page (a carousel
  // of other items, for example) must not turn an out-of-stock product on.
  const inStock = next ? schemaBuy : schemaBuy || add
  if (!next && add && !schemaBuy && fulfillment === "unknown") fulfillment = "ship"
  const status: PageAvailability = !inStock ? "UNAVAILABLE" : preorder ? "PRE_ORDER" : "IN_STOCK"
  const name = title || sku
  const priced = price !== undefined ? ` at $${price.toFixed(2)}` : ""
  const reason = inStock
    ? `${name} is ${status === "PRE_ORDER" ? "open for preorder" : "in stock"}${priced}.`
    : reasonOverride
      ? reasonOverride
      : spec.cautiousOutOfStock
        ? `${name} has no add-to-cart control on the Costco page. Warehouse inventory was not read.`
        : `${name} is not available on the product page.`
  return {
    inStock,
    status,
    title,
    sku,
    price,
    reason,
    seller: spec.name,
    imageUrl,
    fulfillment,
    ...(limit ? { limit } : {}),
    source
  }
}

interface SamsData {
  title?: string
  price?: number
  image?: string
  inStock: boolean
  shipping?: boolean
  pickup: boolean
  preorder: boolean
  limit?: number
}

/** The product object in the page's Next.js data. Nothing here needs a session. */
function readSamsData(body: string): SamsData | null {
  const match = body.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)
  if (!match) return null
  const root = asRecord(safeJson(match[1] ?? ""))
  const product = asRecord(asRecord(asRecord(asRecord(asRecord(root?.props)?.pageProps)?.initialData)?.data)?.product)
  if (!product) return null
  const options = Array.isArray(product.fulfillmentOptions) ? product.fulfillmentOptions.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : []
  const live = (value: unknown) => /^(?:IN_STOCK|AVAILABLE|LIMITED|LOW_STOCK|PRE_?ORDER)/i.test(text(value))
  const ship = options.find((item) => /^(?:SHIPPING|DELIVERY)$/i.test(text(item.type)))
  const pick = options.find((item) => /^PICKUP$/i.test(text(item.type)))
  const status = text(asRecord(product.availabilityStatusV2)?.value) || text(product.availabilityStatus)
  const priceInfo = asRecord(product.priceInfo)
  const channel = Array.isArray(product.channelLevelPriceInfo) ? asRecord(asRecord(product.channelLevelPriceInfo[0])?.channelPriceInfo) : null
  const price = money(asRecord(priceInfo?.currentPrice)?.price ?? asRecord(channel?.currentPrice)?.price)
  const images = asRecord(product.imageInfo)
  const first = Array.isArray(images?.allImages) ? asRecord(images.allImages[0]) : null
  const image = text(first?.url) || text(images?.thumbnailUrl)
  const limits = [Number(product.memberLimit), Number(product.orderLimit)].filter((value) => Number.isFinite(value) && value > 0)
  return {
    title: text(product.name) || undefined,
    price,
    image: image.startsWith("https://") ? image : undefined,
    inStock: live(status),
    shipping: ship ? live(ship.availabilityStatus) : undefined,
    pickup: pick ? live(pick.availabilityStatus) : false,
    preorder: asRecord(product.preOrder)?.isPreOrder === true,
    limit: limits.length ? Math.min(...limits) : undefined
  }
}

interface LdReading {
  found: boolean
  title?: string
  price?: number
  image?: string
  availability: string
}

/**
 * schema.org Product data. A ProductGroup (Barnes & Noble) lists one Product per format.
 * The edition in the link wins. Otherwise a buyable physical format is used, then the first physical one.
 */
function readJsonLd(body: string, variant?: string): LdReading {
  const nodes: Record<string, unknown>[] = []
  for (const block of body.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) collectProducts(safeJson(block[1] ?? ""), nodes)
  if (!nodes.length) return { found: false, availability: "" }
  const readNode = (node: Record<string, unknown>): LdReading => {
    const offer = firstOffer(node.offers)
    const amount = priceOf(offer)
    return {
      found: true,
      title: text(node.name) || undefined,
      price: amount ?? money(node.price),
      image: imageOf(node.image),
      availability: text(offer?.availability || node.availability)
    }
  }
  const variants = nodes.filter((node) => text(node["@type"]) !== "ProductGroup" && Boolean(node.offers))
  const group = nodes.find((node) => text(node["@type"]) === "ProductGroup")
  const own = variants.filter((node) => !isDigitalFormat(node))
  const pool = own.length ? own : variants
  let pick: Record<string, unknown> | undefined
  if (variant) pick = variants.find((node) => text(node.sku) === variant || text(node.gtin13) === variant || text(node.url).includes(`ean=${variant}`))
  if (!pick && group && pool.length > 1) pick = pool.find((node) => /instock|limitedavailability|pre-?order|pre-?sale/i.test(text(firstOffer(node.offers)?.availability))) ?? pool[0]
  pick ??= pool[0] ?? nodes[0]
  const reading = readNode(pick)
  if (group && !reading.title) reading.title = text(group.name) || undefined
  if (group && !reading.image) reading.image = imageOf(group.image)
  const format = text(pick.bookFormat).replace(/^.*\//, "")
  if (group && format && reading.title && new Set(variants.map((node) => text(node.bookFormat)).filter(Boolean)).size > 1) reading.title = `${reading.title} (${format})`
  return reading
}

function collectProducts(node: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectProducts(item, out)
    return
  }
  const record = asRecord(node)
  if (!record) return
  const type = Array.isArray(record["@type"]) ? record["@type"].map(text).join(" ") : text(record["@type"])
  if (/\bProduct\b|\bProductGroup\b/.test(type)) {
    out.push(record)
    if (Array.isArray(record.hasVariant)) for (const item of record.hasVariant) collectProducts(item, out)
  }
  if (record["@graph"]) collectProducts(record["@graph"], out)
}

function isDigitalFormat(node: Record<string, unknown>): boolean {
  const format = `${text(node.bookFormat)} ${text(node.additionalType)} ${text(node.name)}`.toLowerCase()
  return /ebook|audiobook|nook|digital/.test(format)
}

/** A price from an offer: a plain price, a price range, or a list of price specifications. */
function priceOf(offer: Record<string, unknown> | null): number | undefined {
  if (!offer) return undefined
  const direct = money(offer.price ?? offer.lowPrice)
  if (direct !== undefined) return direct
  const specs = Array.isArray(offer.priceSpecification) ? offer.priceSpecification : offer.priceSpecification ? [offer.priceSpecification] : []
  const prices = specs.map((item) => money(asRecord(item)?.price)).filter((value): value is number => value !== undefined)
  // The member price is the lowest. Zzz AIO reports what the signed-in member pays.
  return prices.length ? Math.min(...prices) : undefined
}

function imageOf(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value
  const url = typeof first === "string" ? first : text(asRecord(first)?.url)
  return url.startsWith("https://") && url.length < 400 ? url : undefined
}

function readMeta(body: string): { title?: string; image?: string; price?: number } {
  const read = (name: string): string => {
    for (const tag of body.slice(0, 200_000).match(/<meta\b[^>]*>/gi) ?? []) {
      const key = tag.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase()
      if (key !== name) continue
      const content = tag.match(/\bcontent=["']([^"']*)["']/i)?.[1]
      if (content) return decodeEntities(content.trim())
    }
    return ""
  }
  const image = read("og:image")
  const amount = money(read("product:price:amount") || read("og:price:amount"))
  return { title: read("og:title") || undefined, image: image.startsWith("https://") ? image : undefined, price: amount }
}

function cleanTitle(value: string | undefined, spec: PageSpec): string {
  const text = (value ?? "").replace(/\s*[|\-–]\s*(?:Costco|Samsclub\.com|GameStop|Barnes\s*&\s*Noble.*?)\s*$/i, "").trim()
  return text && text.toLowerCase() !== spec.name.toLowerCase() ? text : ""
}

/** "Purchase Limit ... only 1 unit of this item may be purchased per account" on a GameStop page. */
function readLimit(body: string): number | undefined {
  const visible = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  const match = visible.match(/purchase limit[\s\S]{0,120}?\bonly\s+(\d{1,2})?\s*(?:unit|item|copy|copies)/i)
  if (!match) return undefined
  return match[1] ? Number(match[1]) : 1
}

function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
}

function barnesCanonical(id: string): string {
  const ean = isbn13(id)
  return ean ? `https://www.barnesandnoble.com/w/?ean=${ean}` : `https://www.barnesandnoble.com/w/${id}`
}

/** An ISBN-13 for a bare ISBN. A 10-digit number that is not a valid ISBN-10 is a Barnes & Noble work id. */
function isbn13(id: string): string {
  if (/^97[89]\d{10}$/.test(id)) return id
  if (!/^\d{9}[\dXx]$/.test(id)) return ""
  const digits = id.toUpperCase().split("").map((char) => (char === "X" ? 10 : Number(char)))
  const sum = digits.reduce((total, digit, index) => total + digit * (10 - index), 0)
  if (sum % 11 !== 0) return ""
  const core = `978${id.slice(0, 9)}`
  const check = (10 - (core.split("").reduce((total, char, index) => total + Number(char) * (index % 2 ? 3 : 1), 0) % 10)) % 10
  return `${core}${check}`
}

export function hasAddControl(html: string): boolean {
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  const tags = visible.match(/<(button|a)\b[^>]*>[\s\S]{0,180}?<\/\1>|<input\b[^>]*>/gi) ?? []
  for (const tag of tags) {
    if (/\bdisabled\b/i.test(tag)) continue
    if (/add[\s-]*to[\s-]*(?:cart|bag)/i.test(tag)) return true
    if (/add-to-cart|addtocart|add_to_cart/i.test(tag)) return true
  }
  return false
}

function productRecord(body: string): Record<string, unknown> | null {
  const blocks = body.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  for (const block of blocks) {
    const found = findProduct(safeJson(block[1] ?? ""))
    if (found) return found
  }
  return null
}

function findProduct(node: unknown): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findProduct(item)
      if (found) return found
    }
    return null
  }
  const record = asRecord(node)
  if (!record) return null
  if (isProductType(record["@type"])) return record
  if (record["@graph"]) return findProduct(record["@graph"])
  return null
}

function isProductType(value: unknown): boolean {
  const list = Array.isArray(value) ? value : [value]
  return list.some((item) => text(item).toLowerCase() === "product")
}

function firstOffer(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const offer = asRecord(item)
      if (offer) return offer
    }
    return null
  }
  return asRecord(value)
}

function money(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value * 100) / 100
  if (typeof value === "string") {
    const match = value.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/)
    if (match) return Math.round(Number(match[1]) * 100) / 100
  }
  return undefined
}

function normalizeId(value: string): string {
  return value.trim().replace(/x$/i, "X")
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
