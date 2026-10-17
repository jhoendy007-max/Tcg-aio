export type CrunchyrollStockStatus = "IN_STOCK" | "OUT_OF_STOCK" | "ABOVE_PRICE" | "NOT_FOUND"

export interface StockReading {
  inStock: boolean
  status: CrunchyrollStockStatus
  title?: string
  sku: string
  price?: number
  listPrice?: number
  reason: string
  imageUrl?: string
}

export interface ShippingMethod {
  id: string
  name: string
  pickup: boolean
}

const SKU_RE = /^\d{8,14}$/
const ORG = "f_ecom_bdgc_prd"

export function parseSku(input: string): string | null {
  const text = input.trim()
  if (SKU_RE.test(text)) return text
  const ids = [...text.matchAll(/(?:^|[^\d])(\d{8,14})(?=\.html|[/?#]|$)/gi)]
  return ids.at(-1)?.[1] ?? null
}

export function productApiUrl(sku: string): string {
  const params = new URLSearchParams({
    siteId: "CrunchyrollUS",
    locale: "en-US",
    currency: "USD",
    expand: "availability,prices"
  })
  return `https://www.crunchyroll.com/mobify/proxy/api/product/shopper-products/v1/organizations/${ORG}/products/${encodeURIComponent(sku)}?${params}`
}

export function productPageUrl(sku: string): string {
  return `https://www.crunchyroll.com/store/products/${encodeURIComponent(sku)}.html`
}

export function basketsUrl(path = ""): string {
  return `https://www.crunchyroll.com/mobify/proxy/api/checkout/shopper-baskets/v1/organizations/${ORG}${path}`
}

export function ordersUrl(): string {
  return `https://www.crunchyroll.com/mobify/proxy/api/checkout/shopper-orders/v1/organizations/${ORG}/orders?siteId=CrunchyrollUS`
}

export function isChallenge(status: number, body: string, mitigated = ""): boolean {
  if (mitigated.toLowerCase() === "challenge") return true
  const lower = body.slice(0, 16000).toLowerCase()
  if (lower.includes("\"orderable\"") || lower.includes("\"productname\"") || lower.includes("\"tieredprices\"")) return false
  if (lower.includes("just a moment") || lower.includes("cf-browser-verification") || lower.includes("challenge-platform") || lower.includes("challenges.cloudflare.com") || lower.includes("attention required")) return true
  if (lower.includes("enable javascript and cookies to continue")) return true
  if (status === 403 && lower.includes("<html") && (lower.includes("cloudflare") || lower.includes("captcha"))) return true
  if (status >= 400 && lower.includes("captcha") && !lower.includes("\"id\"")) return true
  return false
}

export function isUnauthorized(status: number, body: string): boolean {
  if (isChallenge(status, body)) return false
  if (status === 401) return true
  const lower = body.toLowerCase()
  return lower.includes("invalid access token") || lower.includes("unauthorized") && lower.includes("expired")
}

export function isGuestToken(token: string): boolean {
  const payload = jwtPayload(token)
  if (!payload) return false
  const isb = String(payload.isb ?? "")
  const aut = String(payload.aut ?? "").toUpperCase()
  return /guest/i.test(isb) || aut === "GUEST"
}

export function bearerFromSession(accessToken?: string, cookie?: string): string | undefined {
  if (accessToken && accessToken !== "session" && accessToken.startsWith("eyJ")) return accessToken
  if (!cookie) return undefined
  for (const part of cookie.split(/;\s*/)) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (/^(cc-at|cc-at_crunchyrollus|access_token|authorization|token)$/i.test(name) && value.startsWith("eyJ")) return value
    if (value.startsWith("eyJ") && value.split(".").length >= 3) return value
  }
  return undefined
}

export function readStock(body: string, sku: string): StockReading | null {
  const json = safeJson(body)
  if (json === undefined) return null
  const product = findProduct(json, sku)
  if (!product) {
    const record = asRecord(json)
    const title = String(record?.title ?? record?.fault ?? "")
    if (/not found/i.test(title)) return missing(sku)
    return null
  }
  return readingFrom(product, sku)
}

export function readShippingMethods(body: string): ShippingMethod[] {
  const record = asRecord(safeJson(body))
  if (!record) return []
  const raw = [record.applicableShippingMethods, record.shippingMethods, record.methods].find(Array.isArray) as unknown[] | undefined
  if (!raw) return []
  const methods: ShippingMethod[] = []
  for (const item of raw) {
    const row = asRecord(item)
    if (!row) continue
    const id = stringish(row, ["id", "shippingMethodId"])
    if (!id) continue
    const name = stringish(row, ["name", "description", "label"]) ?? id
    const pickupFlag = row.c_storePickupEnabled === true || row.storePickupEnabled === true
    const pickup = pickupFlag || /pick\s?-?up|bopis|in[\s-]?store/i.test(`${name} ${id}`)
    methods.push({ id, name, pickup })
  }
  return methods
}

export function readBasketId(body: string): string | undefined {
  const record = asRecord(safeJson(body))
  if (!record) return undefined
  if (typeof record.basketId === "string" && record.basketId) return record.basketId
  if (Array.isArray(record.basketIds) && typeof record.basketIds[0] === "string") return record.basketIds[0]
  return undefined
}

export function readOrderId(body: string): string | undefined {
  const record = asRecord(safeJson(body))
  if (!record) return undefined
  const nested = asRecord(record.order) ?? record
  for (const key of ["orderNo", "orderNumber", "orderId", "confirmationNumber"]) {
    const value = nested[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number") return String(value)
  }
  return undefined
}

export function readOrderTotal(body: string): number | undefined {
  const record = asRecord(safeJson(body))
  if (!record) return undefined
  for (const key of ["orderTotal", "productTotal"]) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

export function readStripeKey(body: string): string | undefined {
  return body.match(/pk_(?:live|test)_[A-Za-z0-9]+/)?.[0]
}

export function needsShopperAction(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes("requires_action") || lower.includes("requires_source_action") || lower.includes("redirect_to_url")
}

export function outOfStock(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes("product-item-not-available") || lower.includes("not available") || lower.includes("out of stock") || lower.includes("insufficient")
}

export function declined(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes("card_declined") || lower.includes("payment_declined") || lower.includes("your card was declined")
}

function readingFrom(record: Record<string, unknown>, sku: string): StockReading {
  const title = stringish(record, ["name", "productName", "title"])
  const { current, list } = pricesOf(record)
  const inventory = asRecord(record.inventory) ?? {}
  const master = asRecord(record.master)
  const messages = messagesOf(record)
  const text = messages.join(" ").toLowerCase()
  const orderable = inventory.orderable === true || record.orderable === true || record.available === true || master?.orderable === true
  const preorder = inventory.preorderable === true || inventory.backorderable === true || /pre-?order|back[\s-]?order/.test(text)
  const unavailable = /out of stock|unavailable|sold out/.test(text)
  const buyable = (orderable || preorder) && !unavailable
  const label = title ?? `Product ${sku}`
  if (buyable && current !== undefined && list !== undefined && current > list + 0.009) {
    return {
      inStock: false,
      status: "ABOVE_PRICE",
      title,
      sku,
      price: current,
      listPrice: list,
      reason: `${label} is $${current.toFixed(2)}, above the $${list.toFixed(2)} store price.`
    }
  }
  if (buyable) {
    const priceText = current === undefined ? "" : ` at $${current.toFixed(2)}`
    return {
      inStock: true,
      status: "IN_STOCK",
      title,
      sku,
      price: current,
      listPrice: list,
      reason: `${label} is available${priceText}.`
    }
  }
  return {
    inStock: false,
    status: "OUT_OF_STOCK",
    title,
    sku,
    price: current,
    listPrice: list,
    reason: `${label} is ${text || "unavailable"}.`
  }
}

function missing(sku: string): StockReading {
  return { inStock: false, status: "NOT_FOUND", sku, reason: `Crunchyroll did not return product ${sku}.` }
}

function pricesOf(record: Record<string, unknown>): { current?: number; list?: number } {
  const price = asRecord(record.price)
  const sales = asRecord(price?.sales)
  const list = asRecord(price?.list)
  if (sales || list) return { current: numberish(sales?.value), list: numberish(list?.value) }
  let current = typeof record.price === "number" ? record.price : undefined
  let listPrice: number | undefined
  const tiers = Array.isArray(record.tieredPrices) ? record.tieredPrices : []
  for (const tier of tiers) {
    const row = asRecord(tier)
    if (!row || typeof row.price !== "number") continue
    const book = String(row.pricebook ?? "").toLowerCase()
    if (book.includes("list") || book.includes("msrp")) listPrice = row.price
    else current = row.price
  }
  return { current, list: listPrice }
}

function messagesOf(record: Record<string, unknown>): string[] {
  const availability = asRecord(record.availability)
  const messages = availability?.messages
  if (!Array.isArray(messages)) return []
  return messages.filter((item): item is string => typeof item === "string")
}

function findProduct(json: unknown, sku: string): Record<string, unknown> | null {
  const found: Record<string, unknown>[] = []
  walk(json, (record) => {
    const id = stringish(record, ["id", "productId", "pid"])
    if (id === sku && (record.price !== undefined || record.inventory !== undefined || record.available !== undefined || record.name || record.productName)) {
      found.push(record)
    }
  })
  return found[0] ?? null
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (!value || typeof value !== "object") return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit)
    return
  }
  const record = value as Record<string, unknown>
  visit(record)
  for (const nested of Object.values(record)) walk(nested, visit)
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".")
  if (parts.length < 2) return undefined
  try {
    return asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")))
  } catch {
    return undefined
  }
}

function stringish(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function numberish(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
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
