import type { HttpClient, HttpRequest } from "./http"
import type { StoreId } from "../shared/types"
import type { StoreRunContext, StoreRunResult } from "../stores/module"

export type TestStage = "session" | "monitor" | "cart" | "address" | "shipping" | "payment" | "place"
export type CheckResult = "pass" | "fail" | "skip"

export const STAGE_LABEL: Record<TestStage, string> = {
  session: "Session",
  monitor: "Monitor",
  cart: "Add to cart",
  address: "Shipping address",
  shipping: "Shipping method",
  payment: "Payment",
  place: "Place order"
}

export class FinalSubmitBlocked extends Error {
  readonly testMode = true

  constructor(readonly store: StoreId, readonly url: string) {
    super(`Test mode blocked the ${store} place-order request.`)
    this.name = "FinalSubmitBlocked"
  }
}

/** True only for the request that places or submits the order. Payment tokenization is not a final submit. */
export function isFinalSubmit(store: StoreId, request: Pick<HttpRequest, "method" | "url" | "body">): boolean {
  const url = request.url
  const method = request.method
  if (store === "target") return method === "POST" && url.includes("/web_checkouts/v1/checkout")
  if (store === "walmart") return url.includes("/placeOrder/") || (request.body ?? "").includes("placeOrderInput")
  if (store === "bestbuy") {
    if (method !== "POST") return false
    try {
      return /^\/checkout\/v3\/[^/]+$/.test(new URL(url).pathname)
    } catch {
      return false
    }
  }
  if (store === "pokemon-center") return method === "POST" && url.includes("/tpci-ecommweb-api/order")
  if (store === "amazon") return method === "POST" && (url.includes("place-order") || url.includes("/checkout/p/"))
  if (store === "crunchyroll") {
    if (method !== "POST") return false
    try {
      return /\/orders$/.test(new URL(url).pathname)
    } catch {
      return false
    }
  }
  if (store === "bandai") {
    if (method !== "POST") return false
    try {
      return /\/api\/checkout\/[^/]+\/preComplete$/.test(new URL(url).pathname)
    } catch {
      return false
    }
  }
  return false
}

/** Wraps the task HTTP client. In test mode the inner client is never asked to send a place-order request. */
export function guardTestMode(store: StoreId, inner: HttpClient): HttpClient {
  return {
    async request(input) {
      if (isFinalSubmit(store, input)) throw new FinalSubmitBlocked(store, input.url)
      return inner.request(input)
    }
  }
}

export function note(ctx: StoreRunContext, stage: TestStage, result: CheckResult, detail: string): void {
  ctx.mark?.(stage, result, detail)
}

export function finishTest(ctx: StoreRunContext): StoreRunResult {
  note(ctx, "place", "skip", "Test mode stopped before the place-order request. It was not sent.")
  ctx.log("success", "Test mode finished. The place-order request was not sent.")
  return { outcome: "tested", detail: ctx.checklistText?.() || "Test passed. Place order was not sent." }
}
