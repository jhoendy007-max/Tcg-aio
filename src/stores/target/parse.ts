const IN_STOCK = new Set(["IN_STOCK", "LIMITED_STOCK", "PRE_ORDER_SELLABLE"])

export interface StockReading {
  inStock: boolean
  status: string
  title?: string
}

export function parseStock(body: string): StockReading | null {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  const product = firstProduct(json)
  if (!product) return { inStock: false, status: "NOT_FOUND" }
  const title = readTitle(product)
  const fulfillment = asRecord(product.fulfillment)
  if (!fulfillment) return { inStock: false, status: "UNKNOWN", title }
  if (fulfillment.sold_out === true) return { inStock: false, status: "SOLD_OUT", title }
  const status = shippingStatus(fulfillment)
  if (!status) return { inStock: false, status: "UNKNOWN", title }
  return { inStock: IN_STOCK.has(status), status, title }
}

export function isChallenge(status: number, body: string): boolean {
  if (status === 435) return true
  if (status < 400) return false
  const text = body.slice(0, 5000).toLowerCase()
  const markers = [
    "captcha",
    "access denied",
    "px-captcha",
    "perimeterx",
    "/akam/",
    "verify you are human",
    "robot check",
    "shape security",
    "blocked"
  ]
  if (markers.some((marker) => text.includes(marker))) return true
  if (status === 403 && text.includes("<html")) return true
  return false
}

export function isUnauthorized(status: number, body: string): boolean {
  if (status === 401) return true
  const text = body.toLowerCase()
  return text.includes("unauthorized") || text.includes("no authorization header") || text.includes("invalid_guest_status")
}

export function bodyHas(body: string, marker: string): boolean {
  return body.toLowerCase().includes(marker.toLowerCase())
}

export function findCartId(body: string): string | undefined {
  const json = safeJson(body)
  if (!json) return undefined
  const direct = json.cart_id ?? asRecord(json.cart)?.cart_id
  if (typeof direct === "string" && direct) return direct
  return undefined
}

export function findCartItemId(body: string): string | undefined {
  const json = safeJson(body)
  if (!json) return undefined
  if (typeof json.cart_item_id === "string") return json.cart_item_id
  const items = json.cart_items ?? asRecord(json.cart)?.cart_items
  if (Array.isArray(items) && items.length) {
    const id = asRecord(items[0])?.cart_item_id
    if (typeof id === "string") return id
  }
  return undefined
}

export function findOrderId(body: string): string | undefined {
  const json = safeJson(body)
  if (!json) return undefined
  return walkOrder(json)
}

export function paymentInstructionId(body: string): string | undefined {
  const match = body.match(/payment instruction ([A-Za-z0-9-]+)/i)
  return match?.[1]
}

function walkOrder(value: unknown): string | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  if (Array.isArray(record.orders) && record.orders.length) {
    const order = asRecord(record.orders[0])
    const id = order?.order_id ?? order?.order_number ?? order?.reference_id
    if (typeof id === "string" || typeof id === "number") return String(id)
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") {
      const found = walkOrder(child)
      if (found) return found
    }
  }
  return undefined
}

function firstProduct(json: unknown): Record<string, unknown> | undefined {
  const root = asRecord(json)
  const data = asRecord(root?.data) ?? root
  if (!data) return undefined
  if (Array.isArray(data.product_summaries) && data.product_summaries.length) {
    return asRecord(data.product_summaries[0])
  }
  return asRecord(data.product)
}

function readTitle(product: Record<string, unknown>): string | undefined {
  const item = asRecord(product.item)
  const description = asRecord(item?.product_description) ?? asRecord(product.product_description)
  const title = description?.title
  if (typeof title !== "string" || !title.trim()) return undefined
  return decodeEntities(title.trim())
}

export function stockProblem(body: string): string | null {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return null
  }
  const root = asRecord(json)
  const errors = Array.isArray(root?.errors) ? root.errors : []
  const message = errors
    .map((error) => asRecord(error)?.message)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
  if (!message) return null
  const reading = parseStock(body)
  if (reading && reading.status !== "UNKNOWN" && reading.status !== "NOT_FOUND") return null
  return message.trim()
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

function shippingStatus(fulfillment: Record<string, unknown>): string | undefined {
  const options = fulfillment.shipping_options ?? fulfillment.ship_options
  if (Array.isArray(options)) {
    for (const option of options) {
      const status = asRecord(option)?.availability_status
      if (typeof status === "string" && IN_STOCK.has(status)) return status
    }
    const first = asRecord(options[0])?.availability_status
    return typeof first === "string" ? first : undefined
  }
  const record = asRecord(options)
  if (!record) return undefined
  if (typeof record.availability_status === "string") return record.availability_status
  if (Array.isArray(record.services)) {
    for (const service of record.services) {
      const status = asRecord(service)?.availability_status
      if (typeof status === "string") return status
    }
  }
  return undefined
}

function safeJson(body: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(body))
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
