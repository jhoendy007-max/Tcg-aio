import { createHash } from "node:crypto"

export type BestBuyStockStatus =
  | "IN_STOCK"
  | "MARKETPLACE"
  | "ABOVE_MSRP"
  | "NO_SHIPPING"
  | "OUT_OF_STOCK"
  | "NOT_FOUND"

export interface StockReading {
  inStock: boolean
  status: BestBuyStockStatus
  title?: string
  sku: string
  price?: number
  msrp?: number
  seller?: string
  reason: string
}

const SHIP_BUTTONS = new Set(["ADD_TO_CART", "PRE_ORDER", "PRE_ORDER_MOBILE"])

export function parseSku(input: string): string | null {
  const text = input.trim()
  if (/^\d{6,8}$/.test(text)) return text
  const path = text.match(/\/sku\/(\d{6,8})(?:[/?#]|$)/i)
  if (path?.[1]) return path[1]
  const query = text.match(/[?&]skuId=(\d{6,8})\b/i)
  if (query?.[1]) return query[1]
  const legacy = text.match(/\/(\d{6,8})\.p(?:[/?#]|$)/i)
  if (legacy?.[1]) return legacy[1]
  try {
    const url = new URL(text)
    const fromQuery = url.searchParams.get("skuId")
    if (fromQuery && /^\d{6,8}$/.test(fromQuery)) return fromQuery
  } catch {
    return null
  }
  return null
}

export function monitorUrl(input: string, sku: string): string {
  try {
    const url = new URL(input.trim())
    if ((url.hostname === "www.bestbuy.com" || url.hostname === "bestbuy.com") && url.pathname.includes(`/sku/${sku}`)) {
      url.protocol = "https:"
      url.hostname = "www.bestbuy.com"
      return url.toString()
    }
  } catch {
    // A bare SKU has no URL to preserve.
  }
  return `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(sku)}`
}

export function isChallenge(status: number, body: string): boolean {
  if (readQueue(body)) return false
  const text = body.slice(0, 12000).toLowerCase()
  if (text.includes("productbyskuid") || text.includes("__pdp_analytics_payload__")) return false
  if (text.includes("pardon our interruption") || text.includes("please verify you are a human") || text.includes("sec-cp-challenge")) return true
  if (status === 403) {
    if (text.includes("access denied") || text.includes("captcha") || text.includes("akamai") || text.includes("<html")) return true
  }
  if (status >= 400 && text.includes("captcha")) return true
  return false
}

export function isUnauthorized(status: number, body: string): boolean {
  if (status === 401) return true
  const text = body.toLowerCase()
  return text.includes("unauthorized") || text.includes("unauthenticated") || text.includes("invalid_session")
}

export function isGuestCart(body: string): boolean {
  const json = safeJson(body)
  const record = asRecord(json)
  const cart = asRecord(record?.cart)
  const status = String(record?.authStatus ?? cart?.authStatus ?? "").toUpperCase()
  return status === "G" || status === "GUEST" || status === "ANONYMOUS"
}

export function isThreeDSecure(body: string): boolean {
  const text = body.toLowerCase()
  return text.includes("pay_secure_redirect") || text.includes("stepupjwt") || text.includes("cardinalcommerce") || text.includes("threedsecure/redirect")
}

export function readQueue(body: string): string | null {
  const upper = body.toUpperCase()
  if (upper.includes("CONSTRAINED_ITEM_DHV")) return "CONSTRAINED_ITEM_DHV"
  if (upper.includes("CONSTRAINED_ITEM_PERPETUAL")) return "CONSTRAINED_ITEM_PERPETUAL"
  if (upper.includes("CONSTRAINED_ITEM")) return "CONSTRAINED_ITEM"
  if (body.toLowerCase().includes("please wait")) return "PLEASE_WAIT"
  return null
}

export function decodeQueueSeconds(code: string, sku: string): number | null {
  if (code.length < 7 + 64) return null
  const iterations = Number.parseInt(code.slice(0, 3), 16)
  if (!Number.isInteger(iterations) || iterations < 0 || iterations > 256) return null
  const marker = code.slice(3, 7)
  const target = code.slice(7).toLowerCase()
  for (let seconds = 0; seconds < 900; seconds += 1) {
    let hashed = Buffer.from(`${seconds}${marker}${sku}`)
    for (let i = 0; i < iterations; i += 1) hashed = createHash("sha256").update(hashed).digest()
    if (hashed.toString("hex") === target) return seconds
  }
  return null
}

export function readStock(body: string, sku: string): StockReading | null {
  const products = extractProducts(body)
  if (!products.length) return null
  const matches = products.filter((product) => readString(product.skuId) === sku)
  if (!matches.length) {
    return reading(sku, "NOT_FOUND", false, undefined, `Best Buy returned a different SKU than ${sku}.`)
  }
  const product = matches.find((item) => buttonState(item)) ?? matches[0]
  if (!product) return null
  return classify(product, sku)
}

export interface OrderDetails {
  orderId: string
  paymentId: string
  userOrderId: string
  itemIds: string[]
  shippingEligible: boolean
}

export function readOrderDetails(body: string): OrderDetails | null {
  const marker = "var orderData ="
  const at = body.indexOf(marker)
  if (at < 0) return null
  const brace = body.indexOf("{", at + marker.length)
  if (brace < 0) return null
  const raw = sliceJson(body, brace)
  if (!raw) return null
  const json = safeJson(raw)
  const order = asRecord(json)
  if (!order) return null
  const orderId = readString(order.id)
  const paymentId = readString(asRecord(order.payment)?.id)
  const userOrderId = readString(order.userOrderId)
  const items = Array.isArray(order.items) ? order.items : []
  const itemIds = items.map((item) => readString(asRecord(item)?.id)).filter((id): id is string => Boolean(id))
  const first = asRecord(items[0])
  const meta = asRecord(first?.meta)
  const eligibility = asRecord(meta?.fulfillmentEligibilities)
  if (!orderId || !paymentId) return null
  return {
    orderId,
    paymentId,
    userOrderId: userOrderId ?? "",
    itemIds,
    shippingEligible: eligibility?.shippingEligible === true
  }
}

function classify(product: Record<string, unknown>, sku: string): StockReading {
  const title = productTitle(product)
  const seller = asRecord(product.seller)
  const sellerName = sellerLabel(seller)
  const price = priceOf(product)
  const button = buttonState(product)
  const ships = shippingEligible(product)
  if (!isBestBuy(seller)) {
    return reading(sku, "MARKETPLACE", false, title, `${title ? `${title} is` : "This listing is"} sold by ${sellerName}, not Best Buy.`, price.current, price.regular, sellerName)
  }
  const shippable = Boolean(button && SHIP_BUTTONS.has(button) && ships)
  if (shippable) {
    if (price.current === undefined) {
      return reading(sku, "OUT_OF_STOCK", false, title, "Best Buy did not return a price.", undefined, price.regular, sellerName)
    }
    if (price.regular !== undefined && price.current > price.regular + 0.009) {
      return reading(sku, "ABOVE_MSRP", false, title, `Best Buy price $${price.current.toFixed(2)} is above $${price.regular.toFixed(2)}.`, price.current, price.regular, sellerName)
    }
    const label = button === "ADD_TO_CART" ? "Add to cart" : "Pre-order"
    return reading(sku, "IN_STOCK", true, title, `${title ? `${title} is` : "Item is"} sold by Best Buy for ship-to-home at $${price.current.toFixed(2)} (${label}).`, price.current, price.regular, sellerName)
  }
  if (button === "SOLD_OUT" || button === "COMING_SOON") {
    return reading(sku, "OUT_OF_STOCK", false, title, "Best Buy shows this SKU as unavailable.", price.current, price.regular, sellerName)
  }
  if (!ships || button === "IN_STORE_ONLY" || button === "CHECK_STORES") {
    return reading(sku, "NO_SHIPPING", false, title, "Best Buy is not offering ship-to-home for this SKU.", price.current, price.regular, sellerName)
  }
  return reading(sku, "OUT_OF_STOCK", false, title, "Best Buy did not return ship-to-home stock.", price.current, price.regular, sellerName)
}

function reading(
  sku: string,
  status: BestBuyStockStatus,
  inStock: boolean,
  title: string | undefined,
  reason: string,
  price?: number,
  msrp?: number,
  seller?: string
): StockReading {
  return { inStock, status, title, sku, price, msrp, seller, reason }
}

function extractProducts(body: string): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = []
  const needle = '"productBySkuId":'
  let from = 0
  while (products.length < 30) {
    const at = body.indexOf(needle, from)
    if (at < 0) break
    const brace = body.indexOf("{", at + needle.length)
    if (brace < 0) break
    const raw = sliceJson(body, brace)
    from = brace + 1
    if (!raw) continue
    const product = asRecord(safeJson(raw))
    if (product) products.push(product)
  }
  return products
}

function sliceJson(text: string, start: number): string | null {
  if (text[start] !== "{") return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === "\"") inString = false
      continue
    }
    if (char === "\"") inString = true
    else if (char === "{") depth += 1
    else if (char === "}") {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function isBestBuy(seller: Record<string, unknown> | undefined): boolean {
  if (!seller) return false
  const classification = readString(seller.classification)?.toUpperCase()
  if (classification === "3P") return false
  if (classification === "1P") return true
  const id = readString(seller.id)?.toLowerCase()
  if (id === "bby") return true
  const name = `${readString(seller.name) ?? ""} ${readString(seller.displayName) ?? ""}`
  return /best buy/i.test(name)
}

function sellerLabel(seller: Record<string, unknown> | undefined): string {
  if (isBestBuy(seller)) return "Best Buy"
  return readString(seller?.displayName) ?? readString(seller?.name) ?? (readString(seller?.id) ? `seller ${readString(seller?.id)}` : "a marketplace seller")
}

function buttonState(product: Record<string, unknown>): string | undefined {
  const options = asRecord(product.fulfillmentOptions)
  const buttons = Array.isArray(options?.buttonStates) ? options.buttonStates : []
  const records = buttons.map((button) => asRecord(button)).filter((button): button is Record<string, unknown> => Boolean(button))
  const selected = records.find((button) => (readString(button.condition) ?? "NEW").toUpperCase() === "NEW") ?? records[0]
  return readString(selected?.buttonState)?.toUpperCase()
}

function shippingEligible(product: Record<string, unknown>): boolean {
  const options = asRecord(product.fulfillmentOptions)
  const details = Array.isArray(options?.shippingDetails) ? options.shippingDetails : []
  for (const detail of details) {
    const record = asRecord(detail)
    const availability = Array.isArray(record?.shippingAvailability) ? record.shippingAvailability : []
    for (const entry of availability) {
      const row = asRecord(entry)
      const condition = (readString(row?.condition) ?? "NEW").toUpperCase()
      if (condition === "NEW" && row?.shippingEligible === true) return true
    }
  }
  return false
}

function priceOf(product: Record<string, unknown>): { current?: number; regular?: number } {
  const price = asRecord(product.price)
  return {
    current: readNumber(price?.customerPrice ?? price?.currentPrice),
    regular: readNumber(price?.regularPrice ?? price?.displayableRegularPrice ?? price?.listPrice)
  }
}

function productTitle(product: Record<string, unknown>): string | undefined {
  const name = product.name
  if (typeof name === "string" && name.trim()) return name.trim()
  return readString(asRecord(name)?.short)
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}
