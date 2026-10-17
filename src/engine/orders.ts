import type { OrderStatus, StoreId } from "../shared/types"

const TRACKING = /\b(1Z[0-9A-Z]{16}|9[0-9]{15,21}|[0-9]{12}|[0-9]{15}|[0-9]{20})\b/i

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
  const body = text.slice(0, 200_000)
  if (orderId && !body.toLowerCase().includes(orderId.toLowerCase()) && !/order|tracking|shipped|cancel/i.test(body)) return null
  const tracking = TRACKING.exec(body)?.[1]?.toUpperCase() ?? ""
  if (/cancel(?:led|ed)|cancellation/i.test(body)) return { status: "cancelled", tracking }
  if (tracking && /shipped|tracking|on the way|delivered/i.test(body)) return { status: "shipped", tracking }
  if (tracking) return { status: "shipped", tracking }
  if (/order confirmed|thank you for your order|we received your order/i.test(body)) return { status: "confirmed", tracking: "" }
  return null
}
