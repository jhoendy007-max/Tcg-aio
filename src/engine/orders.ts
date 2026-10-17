import type { OrderStatus, StoreId } from "../shared/types"

const TRACKING = /\b(1Z[0-9A-Z]{16}|9[0-9]{15,21}|[0-9]{12}|[0-9]{15}|[0-9]{20})\b/i

export interface ShipmentUpdate {
  status: OrderStatus
  tracking: string
  carrier: string
  detail: string
}

/** Read a shipping email the user already received. This does not send mail. */
export function shipmentFromMail(text: string, orderId: string): ShipmentUpdate | null {
  const body = text.slice(0, 200_000)
  if (!body.trim()) return null
  if (orderId && !body.toLowerCase().includes(orderId.toLowerCase()) && !/order|tracking|shipped|delivered/i.test(body)) return null
  const tracking = TRACKING.exec(body)?.[1]?.toUpperCase() ?? ""
  const carrier = carrierOf(tracking, body)
  if (/cancel(?:led|ed)|cancellation/i.test(body)) return pack("cancelled", tracking, carrier, orderId)
  if (/\bdelivered\b/i.test(body) && !/\b(?:will be|to be|once) delivered\b/i.test(body)) return pack("delivered", tracking, carrier, orderId)
  if (/out for delivery/i.test(body)) return pack("out", tracking, carrier, orderId)
  if (/shipping label|label created/i.test(body)) return pack("label", tracking, carrier, orderId)
  if (tracking && /shipped|tracking|on the way|in transit/i.test(body)) return pack("shipped", tracking, carrier, orderId)
  if (tracking) return pack("shipped", tracking, carrier, orderId)
  if (/order confirmed|thank you for your order|we received your order/i.test(body)) return pack("confirmed", "", carrier, orderId)
  return null
}

function pack(status: OrderStatus, tracking: string, carrier: string, orderId: string): ShipmentUpdate {
  const detail = tracking
    ? `${carrier || "Carrier"} ${tracking}`.trim()
    : `Order ${orderId || "update"} is ${status}.`
  return { status, tracking, carrier, detail: detail.slice(0, 240) }
}

function carrierOf(tracking: string, body: string): string {
  if (/^1Z/i.test(tracking) || /\bUPS\b/.test(body)) return "UPS"
  if (/^9\d{15,21}$/.test(tracking) || /\bUSPS\b/.test(body)) return "USPS"
  if (/\bFedEx\b/i.test(body)) return "FedEx"
  if (/\bDHL\b/.test(body)) return "DHL"
  if (/^\d{12}$/.test(tracking) || /^\d{15}$/.test(tracking)) return "FedEx"
  return ""
}

export function orderStatusUrl(store: StoreId, orderId: string): string | null {
  const id = encodeURIComponent(orderId.trim())
  if (!id) return null
  if (store === "target") return `https://www.target.com/account/orders/${id}`
  if (store === "walmart") return `https://www.walmart.com/orders/${id}`
  if (store === "bestbuy") return `https://www.bestbuy.com/profile/ss/orders/order-details?orderId=${id}`
  if (store === "amazon") return `https://www.amazon.com/gp/your-account/order-details?orderID=${id}`
  if (store === "pokemon-center") return `https://www.pokemoncenter.com/account/orders/${id}`
  if (store === "crunchyroll") return `https://store.crunchyroll.com/account/orders/${id}`
  if (store === "bandai") return `https://p-bandai.com/us/account/order-history`
  if (store === "gamestop") return "https://www.gamestop.com/"
  if (store === "barnes-noble") return "https://www.barnesandnoble.com/"
  if (store === "costco") return "https://www.costco.com/"
  if (store === "sams") return "https://www.samsclub.com/"
  if (store === "tcgplayer") return "https://www.tcgplayer.com/"
  const _exhaustive: never = store
  return _exhaustive
}

/** Read a status from an order page or a mailbox the user connected. */
export function readOrderUpdate(text: string, orderId: string): { status: OrderStatus; tracking: string } | null {
  const update = shipmentFromMail(text, orderId)
  if (!update) return null
  return { status: update.status, tracking: update.tracking }
}
