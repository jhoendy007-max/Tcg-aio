export type PokemonCenterStockStatus = "IN_STOCK" | "OUT_OF_STOCK" | "NOT_FOUND"

export interface StockReading {
  inStock: boolean
  status: PokemonCenterStockStatus
  title?: string
  sku: string
  price?: number
  productUri: string
  availability: string
  reason: string
}

export interface QueueTarget {
  host: string
  customerId: string
  eventId: string
  targetUrl: string
  layoutName: string
}

export interface QueueTicket {
  ahead?: string
  updateIntervalMs?: number
  redirectUrl?: string
  challenge: boolean
}

export interface ShippingMethod {
  id: string
  name: string
  pickup: boolean
}

const SKU_RE = /^\d{2,6}(?:-\d{2,6})+$/
const BUYABLE = new Set(["IN_STOCK", "AVAILABLE", "LOW_STOCK", "PRE_ORDER", "PREORDER"])
const SKU_KEYS = ["pid", "sku", "productId", "product_id", "itemId"]
const STATUS_KEYS = ["availability_status", "availabilityStatus", "availability", "inventoryStatus", "stockStatus"]
const TITLE_KEYS = ["title", "name", "displayName", "productName"]
const URI_KEYS = ["addToCartForm", "productURI", "productUri"]
const PRICE_KEYS = ["sale_price", "price", "display_price", "listPrice"]

export function parseSku(input: string): string | null {
  const text = input.trim()
  if (SKU_RE.test(text)) return text
  try {
    const url = new URL(text)
    const match = url.pathname.match(/\/product\/(\d{2,6}(?:-\d{2,6})+)/i)
    if (match?.[1]) return match[1]
    const query = url.searchParams.get("pid") ?? url.searchParams.get("sku")
    if (query && SKU_RE.test(query)) return query
  } catch {
    return null
  }
  return null
}

export function isProductUrl(input: string, sku: string): boolean {
  try {
    const url = new URL(input.trim())
    const host = url.hostname.toLowerCase()
    if (host !== "www.pokemoncenter.com" && host !== "pokemoncenter.com") return false
    return url.pathname.toLowerCase().includes(`/product/${sku.toLowerCase()}`)
  } catch {
    return false
  }
}

export function productUrl(input: string, sku: string): string {
  if (isProductUrl(input, sku)) {
    const url = new URL(input.trim())
    url.protocol = "https:"
    url.hostname = "www.pokemoncenter.com"
    return url.toString()
  }
  return `https://www.pokemoncenter.com/product/${encodeURIComponent(sku)}`
}

export function searchUrl(sku: string): string {
  const params = new URLSearchParams({
    fl: "availability_status,display_price,pid,price,sale_price,title,url",
    q: sku,
    rows: "24",
    search_type: "keyword",
    start: "0"
  })
  return `https://www.pokemoncenter.com/tpci-ecommweb-api/search?${params.toString()}`
}

export function isChallenge(status: number, body: string): boolean {
  if (looksLikeQueue(body)) return false
  const text = body.slice(0, 20000)
  const lower = text.toLowerCase()
  if (lower.includes("__next_data__") && (lower.includes("addtocartform") || lower.includes("availability_status"))) return false
  if (lower.includes("captcha-delivery.com") || lower.includes("var dd=") || lower.includes("please enable js and disable any ad blocker")) return true
  if (lower.includes("pardon our interruption") || lower.includes("incapsula incident") || lower.includes("_incapsula_resource") || lower.includes("request unsuccessful")) return true
  if (lower.includes("blocked by our security service") || lower.includes("__imperva_")) return true
  if (status === 403 && (lower.includes("captcha") || lower.includes("datadome") || lower.includes("<html"))) return true
  return false
}

export function isUnauthorized(status: number, body: string): boolean {
  if (isChallenge(status, body)) return false
  if (status === 401) return true
  const lower = body.toLowerCase()
  return lower.includes("session expired") || lower.includes("invalid_session") || lower.includes("unauthenticated")
}

export function isGuestCart(body: string): boolean {
  const record = asRecord(safeJson(body))
  if (!record) return false
  if (record.guest === true || record.isGuest === true || record.authenticated === false) return true
  const status = String(record.authStatus ?? record.auth_status ?? "").toUpperCase()
  return status === "G" || status === "GUEST" || status === "ANONYMOUS"
}

export function readQueueTarget(status: number, body: string, location: string): QueueTarget | null {
  const fromLocation = queueFromUrl(resolveLocation(location))
  if (fromLocation && (isRedirect(status) || looksLikeQueue(body))) return fromLocation
  if (!looksLikeQueue(body)) return null
  const customerId = body.match(/customerId["']?\s*[:=]\s*["']([^"']+)/i)?.[1]
  const eventId = body.match(/eventId["']?\s*[:=]\s*["']([^"']+)/i)?.[1]
  const host = body.match(/https?:\/\/([a-z0-9.-]*queue-it\.net)/i)?.[1]
  const targetUrl = body.match(/targetUrl["']?\s*[:=]\s*["']([^"']+)/i)?.[1] ?? "https://www.pokemoncenter.com/"
  const layoutName = body.match(/layoutName["']?\s*[:=]\s*["']([^"']+)/i)?.[1] ?? "Default layout"
  if (customerId && eventId && host && isQueueHost(host)) {
    return { host, customerId, eventId, targetUrl, layoutName }
  }
  return null
}

export function readEnqueue(body: string): { queueId?: string; redirectUrl?: string; challenge: boolean } {
  const record = asRecord(safeJson(body)) ?? {}
  return {
    queueId: typeof record.queueId === "string" ? record.queueId : undefined,
    redirectUrl: nonEmpty(record.redirectUrl),
    challenge: queueChallenge(record)
  }
}

export function readQueueStatus(body: string): QueueTicket {
  const record = asRecord(safeJson(body)) ?? {}
  const ticket = asRecord(record.ticket) ?? {}
  const aheadRaw = ticket.usersInLineAheadOfYou ?? ticket.queueNumber
  const update = typeof record.updateInterval === "number" ? record.updateInterval : undefined
  return {
    ahead: aheadRaw === undefined || aheadRaw === null || aheadRaw === "" ? undefined : String(aheadRaw),
    updateIntervalMs: update,
    redirectUrl: nonEmpty(record.redirectUrl),
    challenge: queueChallenge(record)
  }
}

export function readStock(body: string, sku: string): StockReading | null {
  const json = safeJson(body) ?? safeJson(nextData(body) ?? "")
  if (json === undefined) return null
  const docs = searchDocs(json)
  if (docs) {
    const match = docs.find((doc) => skuOf(doc) === sku)
    if (!match) return reading(sku, "NOT_FOUND", false, undefined, "", `Pokémon Center search did not return SKU ${sku}.`)
    return readingFrom(match, sku)
  }
  const product = findProduct(json, sku)
  if (!product) return null
  return readingFrom(product, sku)
}

export function readShippingMethods(body: string): ShippingMethod[] {
  const record = asRecord(safeJson(body))
  if (!record) return []
  const raw = [record.shippingMethods, record.methods, record.availableShippingMethods, record.shipping_methods].find(Array.isArray) as unknown[] | undefined
  if (!raw) return []
  const methods: ShippingMethod[] = []
  for (const item of raw) {
    const row = asRecord(item)
    if (!row) continue
    const id = stringish(row, ["id", "shippingMethodId", "code", "methodId"])
    if (!id) continue
    const name = stringish(row, ["name", "label", "description"]) ?? id
    const type = stringish(row, ["type", "fulfillmentType", "deliveryType"]) ?? ""
    methods.push({ id, name, pickup: /pick\s?-?up|bopis|in[\s-]?store|store\s?pickup/i.test(`${name} ${type}`) })
  }
  return methods
}

export function readOrderId(body: string): string | undefined {
  const record = asRecord(safeJson(body))
  if (!record) return undefined
  const nested = asRecord(record.order) ?? record
  for (const key of ["orderId", "orderNumber", "confirmationNumber", "id"]) {
    const value = nested[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number") return String(value)
  }
  return undefined
}

export function isQueueHost(host: string): boolean {
  const name = host.toLowerCase()
  return name === "queue-it.net" || name.endsWith(".queue-it.net")
}

function readingFrom(record: Record<string, unknown>, sku: string): StockReading {
  const availability = normalizeStatus(stringish(record, STATUS_KEYS) ?? "")
  const title = stringish(record, TITLE_KEYS)
  const price = numberish(record, PRICE_KEYS)
  const productUri = stringish(record, URI_KEYS) ?? stringish(record, ["url"]) ?? `/product/${sku}`
  const buyable = BUYABLE.has(availability)
  const label = title ? `${title} is` : `SKU ${sku} is`
  const reason = buyable
    ? `${label} available (${availability || "IN_STOCK"}).`
    : `${label} ${availability || "unavailable"}.`
  return reading(sku, buyable ? "IN_STOCK" : availability === "" ? "OUT_OF_STOCK" : "OUT_OF_STOCK", buyable, title, productUri, reason, price, availability || "UNKNOWN")
}

function reading(
  sku: string,
  status: PokemonCenterStockStatus,
  inStock: boolean,
  title: string | undefined,
  productUri: string,
  reason: string,
  price?: number,
  availability = ""
): StockReading {
  return { inStock, status, title, sku, price, productUri, availability, reason }
}

function searchDocs(json: unknown): Record<string, unknown>[] | null {
  const record = asRecord(json)
  const response = asRecord(record?.response)
  if (!response || !Array.isArray(response.docs)) return null
  return response.docs.map(asRecord).filter((doc): doc is Record<string, unknown> => Boolean(doc))
}

function findProduct(json: unknown, sku: string): Record<string, unknown> | null {
  const found: Record<string, unknown>[] = []
  walk(json, (record) => {
    if (skuOf(record) === sku && stringish(record, STATUS_KEYS)) found.push(record)
  })
  return found.find((record) => stringish(record, URI_KEYS)) ?? found[0] ?? null
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

function skuOf(record: Record<string, unknown>): string | null {
  for (const key of SKU_KEYS) {
    const value = record[key]
    if (typeof value === "string" && SKU_RE.test(value)) return value
  }
  const id = record.id
  if (typeof id === "string" && SKU_RE.test(id)) return id
  return null
}

function normalizeStatus(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]+/g, "_")
}

function queueFromUrl(raw: string): QueueTarget | null {
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!isQueueHost(url.hostname)) return null
  const customerId = url.searchParams.get("c") ?? ""
  const eventId = url.searchParams.get("e") ?? ""
  if (!customerId || !eventId) return null
  return {
    host: url.hostname,
    customerId,
    eventId,
    targetUrl: url.searchParams.get("t") || "https://www.pokemoncenter.com/",
    layoutName: "Default layout"
  }
}

function queueChallenge(record: Record<string, unknown>): boolean {
  if (record.challengeRequired === true || record.missingChallenge === true || record.challengeFailed === true) return true
  const type = String(record.challengeType ?? record.challenge ?? "").toLowerCase()
  if (type.includes("captcha") || type.includes("proofofwork") || type.includes("botdetect")) return true
  return Array.isArray(record.challenges) && record.challenges.length > 0
}

function looksLikeQueue(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes("queue-it.net") || lower.includes("queueittoken") || lower.includes("inqueueview")
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

function resolveLocation(location: string): string {
  if (!location) return ""
  try {
    return new URL(location, "https://www.pokemoncenter.com").toString()
  } catch {
    return location
  }
}

function nextData(body: string): string | null {
  const match = body.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  return match?.[1] ?? null
}

function stringish(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number") return String(value)
  }
  return undefined
}

function numberish(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
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
