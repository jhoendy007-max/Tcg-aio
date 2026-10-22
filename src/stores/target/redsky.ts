import { randomBytes } from "node:crypto"
import { chromeUserAgent } from "../../engine/chrome-ua"

/** Public web key shipped in target.com. A preview date is not sent for a normal visit. */
export const TARGET_REDSKY_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96"

/** Stable id for health and proxy probes. Live monitors use a fresh id per task. */
export const TARGET_PROBE_VISITOR = "0100000000000200AFC86BA9A4764824"

const visitors = new Map<string, string>()

/** 32 hex characters, the same shape as the visitorId cookie on target.com. */
export function anonymousVisitorId(taskId: string): string {
  const existing = visitors.get(taskId)
  if (existing) return existing
  const id = randomBytes(16).toString("hex").toUpperCase()
  visitors.set(taskId, id)
  return id
}

export function resetAnonymousVisitors(): void {
  visitors.clear()
}

export interface TargetMonitorQuery {
  key: string
  tcin: string
  storeId: string
  zip: string
  state: string
  visitorId: string
}

/**
 * Query the product-summary call shares with a guest PDP.
 * The live client sends key, visitor_id, and pricing_store_id.
 * It does not send x-requested-with. Membership flags are false for a guest.
 */
export function targetMonitorParams(input: TargetMonitorQuery, idField: "tcins" | "tcin" = "tcins"): URLSearchParams {
  const params = new URLSearchParams()
  params.set("key", input.key)
  params.set(idField, input.tcin)
  params.set("store_id", input.storeId)
  params.set("pricing_store_id", input.storeId)
  params.set("scheduled_delivery_store_id", input.storeId)
  params.set("required_store_id", input.storeId)
  params.set("zip", input.zip)
  params.set("state", input.state)
  params.set("channel", "WEB")
  params.set("page", `/p/A-${input.tcin}`)
  params.set("visitor_id", input.visitorId)
  params.set("paid_membership", "false")
  params.set("base_membership", "false")
  params.set("card_membership", "false")
  return params
}

export function targetMonitorUrl(input: TargetMonitorQuery): string {
  const url = new URL("https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1")
  targetMonitorParams(input).forEach((value, key) => url.searchParams.set(key, value))
  return url.toString()
}

export function targetFulfillmentUrl(input: TargetMonitorQuery): string {
  const url = new URL("https://redsky.target.com/redsky_aggregations/v1/web/pdp_fulfillment_v1")
  targetMonitorParams(input, "tcin").forEach((value, key) => url.searchParams.set(key, value))
  return url.toString()
}

/** Headers a guest browser sends to redsky. x-requested-with is not one of them. */
export function targetMonitorHeaders(tcin: string, visitorId: string, includeVisitorCookie: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.target.com",
    referer: `https://www.target.com/p/-/A-${tcin}`,
    "user-agent": chromeUserAgent()
  }
  if (includeVisitorCookie) headers.cookie = `visitorId=${visitorId}`
  return headers
}
