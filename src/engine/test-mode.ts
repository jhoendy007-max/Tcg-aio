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
  if (store === "gamestop") return postPath(method, url, /CheckoutServices-PlaceOrder$/)
  if (store === "barnes-noble") return postPath(method, url, /\/checkout\/api\/place-order$/)
  if (store === "costco") return postPath(method, url, /\/ebusiness\/order\/v1\/orders\/place$/)
  if (store === "sams") return postPath(method, url, /\/checkout\/placeorder$/)
  if (store === "tcgplayer") return postPath(method, url, /\/checkout\/place-order$/)
  const _exhaustive: never = store
  return _exhaustive
}

function postPath(method: string, url: string, pattern: RegExp): boolean {
  if (method !== "POST") return false
  try {
    return pattern.test(new URL(url).pathname)
  } catch {
    return false
  }
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
  note(ctx, "place", "skip", "Simulated: this is where the order would be placed. The request was not sent.")
  ctx.log("success", "DRY RUN finished. Every step up to place order ran for real; place order was simulated and never sent.")
  return { outcome: "tested", detail: dryRunSummary(ctx.checklistText?.() ?? "") }
}

/** One-line summary for the task status, e.g. "DRY RUN passed · 6 pass · 1 skip · place order simulated". */
export function dryRunSummary(checklist: string): string {
  const lines = checklist.split("\n").filter(Boolean)
  const count = (word: string) => lines.filter((line) => line.includes(`${word} `)).length
  const fails = count("FAIL")
  const head = fails ? `DRY RUN found ${fails} problem${fails === 1 ? "" : "s"}` : "DRY RUN passed"
  return `${head} · ${count("PASS")} pass · ${count("SKIP")} skip · place order simulated, not sent`
}
