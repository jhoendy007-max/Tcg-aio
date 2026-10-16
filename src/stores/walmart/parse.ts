export type WalmartStockStatus =
  | "IN_STOCK"
  | "MARKETPLACE"
  | "ABOVE_MSRP"
  | "NO_SHIPPING"
  | "OUT_OF_STOCK"
  | "NOT_FOUND"

export interface StockReading {
  inStock: boolean
  status: WalmartStockStatus
  title?: string
  offerId?: string
  usItemId?: string
  price?: number
  msrp?: number
  seller?: string
  reason: string
}

const AVAILABLE = new Set(["IN_STOCK", "AVAILABLE", "LIMITED_STOCK"])

export function parseItemId(input: string): string | null {
  const text = input.trim()
  if (/^\d{5,12}$/.test(text)) return text
  const query = text.match(/[?&](?:itemId|usItemId)=(\d{5,12})\b/)
  if (query?.[1]) return query[1]
  const path = text.match(/\/ip\/(?:[^/?#]+\/)?(\d{5,12})(?:[/?#]|$)/)
  if (path?.[1]) return path[1]
  try {
    const url = new URL(text)
    const fromQuery = url.searchParams.get("itemId") ?? url.searchParams.get("usItemId")
    if (fromQuery && /^\d{5,12}$/.test(fromQuery)) return fromQuery
  } catch {
    return null
  }
  return null
}

export function isChallenge(status: number, body: string): boolean {
  if (status === 412 || status === 418 || status === 456) return true
  const text = body.slice(0, 8000).toLowerCase()
  if (text.includes("robot or human?") || text.includes("press-and-hold") || text.includes("press and hold")) return true
  if (status >= 400) {
    if (text.includes("px-captcha") || text.includes("blockscript") || text.includes("/blocked")) return true
    if (status === 403 && text.includes("<html") && !text.includes("__next_data__")) return true
  }
  return false
}

export function isUnauthorized(status: number, body: string): boolean {
  if (status === 401) return true
  const text = body.toLowerCase()
  return text.includes("unauthorized") || text.includes("unauthenticated") || text.includes("invalid_session")
}

export function bodyHas(body: string, marker: string): boolean {
  return body.toLowerCase().includes(marker.toLowerCase())
}

export function readStock(body: string): StockReading | null {
  const json = parsePayload(body)
  if (!json) return null
  const product = findProduct(json)
  if (!product) return null
  const title = readString(product.name)
  const offers = collectOffers(product)
  if (!offers.length) return reading("NOT_FOUND", false, title, "Item was not found.")
  return classify(offers, title, readString(product.usItemId))
}

export function findCartId(body: string): string | undefined {
  const json = safeJson(body)
  if (!json) return undefined
  const data = asRecord(json.data) ?? json
  const cart = asRecord(data.cart) ?? asRecord(data.updateItems) ?? asRecord(asRecord(data.fulfillmentMutations)?.setShipping)
  const id = cart?.id ?? data.cartId
  return typeof id === "string" && id ? id : undefined
}

export function findAddressId(body: string): string | undefined {
  const json = safeJson(body)
  if (!json) return undefined
  const data = asRecord(json.data) ?? json
  const created = asRecord(data.createDeliveryAddress) ?? asRecord(data.createAccountAddress)
  const address = asRecord(created?.newAddress) ?? created
  const id = address?.id
  return typeof id === "string" && id ? id : undefined
}

export function findPaymentId(body: string): string | undefined {
  const json = safeJson(body)
  if (!json) return undefined
  const data = asRecord(json.data) ?? json
  const created = asRecord(data.createAccountCreditCard) ?? asRecord(data.updateAccountCreditCard)
  const card = asRecord(created?.creditCard) ?? created
  const id = card?.id ?? card?.paymentPreferenceId ?? card?.preferenceId
  return typeof id === "string" && id ? id : undefined
}

export function findContractId(body: string): string | undefined {
  const json = safeJson(body)
  if (!json) return undefined
  const data = asRecord(json.data) ?? json
  const contract = asRecord(data.createBuyNowContract)
  const id = contract?.id
  return typeof id === "string" && id ? id : undefined
}

export function findOrderId(body: string): string | undefined {
  const json = safeJson(body)
  if (!json) return undefined
  const data = asRecord(json.data) ?? json
  const placed = asRecord(data.placeOrder)
  if (!placed) return undefined
  const order = asRecord(placed.order)
  const id = order?.id ?? order?.orderId ?? placed.orderId ?? placed.id
  if (typeof id === "string" || typeof id === "number") return String(id)
  return undefined
}

export function graphqlMessage(body: string): string | undefined {
  const json = safeJson(body)
  const errors = json?.errors
  if (!Array.isArray(errors)) return undefined
  for (const error of errors) {
    const message = asRecord(error)?.message
    if (typeof message === "string" && message.trim()) return message.trim()
  }
  return undefined
}

function classify(offers: Record<string, unknown>[], title: string | undefined, fallbackItem: string | undefined): StockReading {
  let above: StockReading | undefined
  let noShip: StockReading | undefined
  let market: StockReading | undefined
  let oos: StockReading | undefined
  for (const offer of offers) {
    const seller = sellerLabel(offer)
    const price = currentPrice(offer)
    const msrp = referencePrice(offer)
    const offerId = readString(offer.offerId)
    const usItemId = readString(offer.usItemId) ?? fallbackItem
    const base = { title, offerId, usItemId, price, msrp, seller }
    const available = isAvailable(offer)
    const walmart = isWalmartOffer(offer)
    if (walmart && available && shipsHome(offer) && atOrBelowMsrp(price, msrp)) {
      const money = formatMoney(price)
      return {
        inStock: true,
        status: "IN_STOCK",
        ...base,
        reason: `Walmart.com ship-to-home${money ? ` at ${money}` : ""}.`
      }
    }
    if (walmart && available && shipsHome(offer) && !atOrBelowMsrp(price, msrp)) {
      above ??= {
        inStock: false,
        status: "ABOVE_MSRP",
        ...base,
        reason: `Walmart.com price ${formatMoney(price)} is above the ${formatMoney(msrp)} reference.`
      }
      continue
    }
    if (walmart && available && !shipsHome(offer)) {
      noShip ??= {
        inStock: false,
        status: "NO_SHIPPING",
        ...base,
        reason: "Walmart.com is not offering ship-to-home."
      }
      continue
    }
    if (!walmart && available) {
      market ??= {
        inStock: false,
        status: "MARKETPLACE",
        ...base,
        reason: `Marketplace seller ${seller || "unknown"}${price !== undefined ? ` at ${formatMoney(price)}` : ""}. Waiting for Walmart.com.`
      }
      continue
    }
    oos ??= {
      inStock: false,
      status: "OUT_OF_STOCK",
      ...base,
      reason: walmart ? "Walmart.com is out of stock for shipping." : "No Walmart.com offer is in stock."
    }
  }
  return above ?? noShip ?? market ?? oos ?? reading("NOT_FOUND", false, title, "Item was not found.")
}

function isWalmartOffer(offer: Record<string, unknown>): boolean {
  const sellerType = readString(offer.sellerType)?.toUpperCase()
  if (sellerType === "INTERNAL") return true
  const catalog = offer.catalogSellerId
  if (catalog === 0 || catalog === "0") return true
  const names = [offer.sellerDisplayName, offer.sellerName]
    .map((value) => readString(value)?.toLowerCase())
    .filter((value): value is string => Boolean(value))
  return names.some((name) => name === "walmart" || name === "walmart.com")
}

function shipsHome(offer: Record<string, unknown>): boolean {
  const options = Array.isArray(offer.fulfillmentOptions) ? offer.fulfillmentOptions : []
  const shipping = options.map(asRecord).find((option) => readString(option?.type)?.toUpperCase() === "SHIPPING")
  if (shipping) return AVAILABLE.has(readString(shipping.availabilityStatus)?.toUpperCase() ?? "")
  const fulfillmentType = readString(offer.fulfillmentType)?.toUpperCase() ?? ""
  if (fulfillmentType === "PICKUP") return false
  const shipStatus = readString(asRecord(offer.shippingOption)?.availabilityStatus)?.toUpperCase() ?? ""
  if (AVAILABLE.has(shipStatus)) return true
  return fulfillmentType === "FC" || fulfillmentType === "SHIPPING"
}

function atOrBelowMsrp(price: number | undefined, msrp: number | undefined): boolean {
  if (price === undefined || msrp === undefined) return true
  return price <= msrp + 0.009
}

function isAvailable(offer: Record<string, unknown>): boolean {
  const direct = readString(offer.availabilityStatus)?.toUpperCase()
  const nested = readString(asRecord(offer.availabilityStatusV2)?.value)?.toUpperCase()
  return AVAILABLE.has(direct ?? "") || AVAILABLE.has(nested ?? "")
}

function currentPrice(offer: Record<string, unknown>): number | undefined {
  const info = asRecord(offer.priceInfo)
  return numberOr(asRecord(info?.currentPrice)?.price) ?? numberOr(asRecord(offer.price)?.price)
}

function referencePrice(offer: Record<string, unknown>): number | undefined {
  const info = asRecord(offer.priceInfo)
  return numberOr(asRecord(info?.listPrice)?.price) ?? numberOr(asRecord(info?.wasPrice)?.price)
}

function sellerLabel(offer: Record<string, unknown>): string | undefined {
  return readString(offer.sellerDisplayName) ?? readString(offer.sellerName)
}

function collectOffers(product: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(product.allOffers)) {
    return product.allOffers.map(asRecord).filter((offer): offer is Record<string, unknown> => Boolean(offer))
  }
  const offers: Record<string, unknown>[] = []
  if (offerLike(product)) offers.push(product)
  if (Array.isArray(product.secondaryOffers)) {
    for (const extra of product.secondaryOffers) {
      const offer = asRecord(extra)
      if (offer) offers.push(offer)
    }
  }
  return offers
}

function offerLike(record: Record<string, unknown>): boolean {
  return Boolean(readString(record.offerId) || readString(record.sellerType) || record.catalogSellerId !== undefined || readString(record.sellerDisplayName))
}

function findProduct(json: Record<string, unknown>): Record<string, unknown> | undefined {
  const data = asRecord(json.data)
  const fromData = asRecord(data?.product)
  if (fromData) return fromData
  const page = asRecord(asRecord(asRecord(json.props)?.pageProps)?.initialData)
  const fromPage = asRecord(asRecord(page?.data)?.product)
  if (fromPage) return fromPage
  if (offerLike(json) || readString(json.usItemId) || readString(json.name)) return json
  return undefined
}

function parsePayload(body: string): Record<string, unknown> | undefined {
  const direct = safeJson(body)
  if (direct) return direct
  const match = body.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i)
  if (!match?.[1]) return undefined
  return safeJson(match[1])
}

function reading(status: WalmartStockStatus, inStock: boolean, title: string | undefined, reason: string): StockReading {
  return { inStock, status, title, reason }
}

function formatMoney(value: number | undefined): string | undefined {
  if (value === undefined) return undefined
  return `$${value.toFixed(2)}`
}

function numberOr(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function readString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

function safeJson(body: string): Record<string, unknown> | undefined {
  try {
    const json = JSON.parse(body) as unknown
    return asRecord(json)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
