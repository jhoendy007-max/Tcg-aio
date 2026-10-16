export type BandaiStockStatus = "IN_STOCK" | "PRE_ORDER" | "OUT_OF_STOCK" | "NOT_FOUND"

export interface StockReading {
  inStock: boolean
  status: BandaiStockStatus
  title?: string
  sku: string
  price?: number
  areaItemNo?: string
  maxQuantity: number
  reason: string
}

export interface CartLine {
  cartItemSn: string
  productCode?: string
  areaItemNo?: string
}

export interface CartReading {
  cartSn: string
  cartId: string
  merchantCartToken: string
  lines: CartLine[]
}

const CODE_RE = /^[A-Za-z][A-Za-z0-9]{5,23}$/
const HOSTS = new Set(["p-bandai.com", "www.p-bandai.com"])

export function parseSku(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const legacy = text.match(/item[_-](\d{4,})/i)
  if (legacy?.[1] && !text.includes("://")) return legacy[1]
  if (CODE_RE.test(text)) return text
  try {
    const url = new URL(text)
    if (!HOSTS.has(url.hostname.toLowerCase())) return null
    const item = url.pathname.match(/\/item\/(?:detail\/)?(?:item[_-])?([A-Za-z0-9]{4,24})\/?$/i)
    if (!item?.[1]) return null
    if (/^\d{4,}$/.test(item[1]) || CODE_RE.test(item[1])) return item[1]
  } catch {
    return null
  }
  return null
}

export function productPageUrl(sku: string): string {
  return `https://p-bandai.com/us/item/${encodeURIComponent(sku)}`
}

export function productApiUrl(sku: string): string {
  return `https://p-bandai.com/api/products/${encodeURIComponent(sku)}`
}

export function searchApiUrl(query: string): string {
  const params = new URLSearchParams({
    keyword: query,
    limit: "24",
    offset: "0",
    _f_productStatuses: "On,Waiting"
  })
  return `https://p-bandai.com/api/search?${params.toString()}`
}

export function isChallenge(status: number, body: string): boolean {
  const sample = body.slice(0, 8000)
  const lower = sample.toLowerCase()
  if (lower.includes("productcode") && (lower.includes("infosection") || lower.includes("productresults"))) return false
  if (lower.includes('new error("halt")') || lower.includes("new error('halt')")) return true
  if (lower.includes("access denied") || lower.includes("just a moment") || lower.includes("verify you are human")) return true
  if (lower.includes("captcha") && !lower.includes("productcode")) return true
  if ((status === 403 || status === 429) && lower.includes("<html") && !lower.includes("productcode")) return true
  return false
}

export function isLoggedIn(body: string): boolean {
  const record = asRecord(safeJson(body))
  return record?.isLoggedIn === true
}

export function readCsrf(body: string): string {
  const record = asRecord(safeJson(body))
  const token = record?.csrfToken
  return typeof token === "string" ? token : ""
}

export function readStock(body: string, sku: string): StockReading | null {
  const record = asRecord(safeJson(body))
  if (!record || typeof record.productCode !== "string") return null
  const info = asRecord(record.infoSection) ?? {}
  const general = asRecord(info.generalProdInfo) ?? {}
  const order = asRecord(info.orderInfo) ?? {}
  const flags = stringList(record.flags)
  const availability = text(general.availabilityStatus)
  const preorder = text(order.preOrderStatus)
  const closed = flags.includes("PRE_ORDER_CLOSED") || availability === "End" || preorder === "End" || general.outOfStock === true
  const qty = availableQty(record)
  const openFlag = flags.includes("IN_STOCK") || flags.includes("PRE_ORDER")
  const inStock = record.discontinued !== true && !closed && qty > 0 && (openFlag || availability === "On" || availability === "Waiting" || preorder === "InProgress")
  const title = localized(info.productName) || localized(asRecord(record.productBreadcrumb)?.productName)
  const price = money(asRecord(info.price)?.fixedListPrice)
  const maxQuantity = positive(asRecord(info.quantityInfo)?.maxQuantity) ?? 10
  const status: BandaiStockStatus = inStock ? (flags.includes("PRE_ORDER") || text(info.productType) === "PreOrder" ? "PRE_ORDER" : "IN_STOCK") : "OUT_OF_STOCK"
  const reason = inStock
    ? `${title || sku} is ${status === "PRE_ORDER" ? "open for preorder" : "in stock"}${price !== undefined ? ` at $${price.toFixed(2)}` : ""}.`
    : `${title || sku} is not available (${flags[0] || availability || "out of stock"}).`
  return {
    inStock,
    status,
    title: title || undefined,
    sku: record.productCode,
    price,
    areaItemNo: firstAreaItem(record, inStock),
    maxQuantity,
    reason
  }
}

export function readCart(body: string): CartReading | null {
  const record = asRecord(safeJson(body))
  if (!record) return null
  const cartSn = text(record.cartSn)
  const cartId = text(record.cartId)
  if (!cartSn && !cartId) return null
  const suffix = text(record.globaleMerchantCartTokenSuffix)
  const merchantCartToken = text(record.merchantCartToken) || (cartId ? `${cartId}_Checkout_${suffix}` : "")
  const lines: CartLine[] = []
  walk(record, (item) => {
    const product = asRecord(item.product) ?? item
    const cartItemSn = text(product.cartItemSn ?? item.cartItemSn)
    if (!cartItemSn || lines.some((line) => line.cartItemSn === cartItemSn)) return
    lines.push({
      cartItemSn,
      productCode: text(product.productCode) || undefined,
      areaItemNo: text(product.areaItemNo ?? item.areaItemNo) || undefined
    })
  })
  return { cartSn: cartSn || cartId, cartId, merchantCartToken, lines }
}

export function cartError(body: string): string {
  const record = asRecord(safeJson(body))
  return text(record?.error)
}

export function outOfStockError(code: string): boolean {
  return code === "CouldNotAddToCartByOutOfStock" || code === "CouldNotAddToCartByPreallocation" || code === "CouldNotAddToCartByEndOfSale"
}

function availableQty(record: Record<string, unknown>): number {
  const map = asRecord(record.areaItemToItemCode) ?? {}
  let best = 0
  for (const value of Object.values(map)) {
    const item = asRecord(value)
    const qty = item?.availableQty
    if (typeof qty === "number" && qty > best) best = qty
  }
  return best
}

function firstAreaItem(record: Record<string, unknown>, inStock: boolean): string | undefined {
  const map = asRecord(record.areaItemToItemCode) ?? {}
  let fallback = ""
  for (const [key, value] of Object.entries(map)) {
    const qty = asRecord(value)?.availableQty
    if (!fallback) fallback = key
    if (typeof qty === "number" && qty > 0) return key
  }
  return inStock ? fallback || undefined : fallback || undefined
}

function money(value: unknown): number | undefined {
  const amount = asRecord(value)?.amount
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined
  return Math.round(amount * 100) / 100
}

function localized(value: unknown): string {
  if (typeof value === "string") return value.trim()
  const record = asRecord(value)
  return text(record?.en) || text(record?.ja)
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string")
}

function positive(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return undefined
  return value
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
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
