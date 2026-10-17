import { holdMonitorOnly, monitorKey, noteWatch, sharedValue } from "../../engine/monitor"
import { finishTest, note } from "../../engine/test-mode"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import { retryWait, type StoreModule, type StoreRunContext, type StoreRunResult } from "../module"
import {
  chooseListings,
  detailsUrl,
  isCatalogChallenge,
  listingsBody,
  listingsUrl,
  parseProductId,
  productPageUrl,
  readListings,
  readProduct,
  type TcgListing,
  type TcgProduct
} from "./parse"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const HOST = "mp-search-api.tcgplayer.com"

export const TCGPLAYER_PAUSE =
  "TCGplayer presented a challenge. Finish it in your own browser, paste a fresh session if needed, then resume. TCGAIO does not solve challenges."

interface Offer {
  product: TcgProduct
  listing?: TcgListing
  inStock: boolean
  reason: string
  seller: string
}

interface StepOk<T> {
  kind: "ok"
  value: T
}
interface StepStop {
  kind: "paused" | "failed" | "retry"
  reason: string
}
type Step<T> = StepOk<T> | StepStop

export function createTcgplayerModule(): StoreModule {
  return {
    id: "tcgplayer",
    displayName: "TCGplayer Direct",
    skuHint: "Product id or tcgplayer.com product URL",
    implemented: true,
    run: (ctx) => runTcgplayer(ctx)
  }
}

async function runTcgplayer(ctx: StoreRunContext): Promise<StoreRunResult> {
  const id = parseProductId(ctx.task.sku)
  if (!id) return fail("Enter a TCGplayer product id or a tcgplayer.com/product/ URL.")
  if (ctx.profile.shipping.country !== "US") return fail("v1 places US ship-to-home orders only.")
  if (ctx.account.store !== "tcgplayer") return fail("Choose a TCGplayer account.")
  const page = productPageUrl(id)
  ctx.phase("monitoring")
  ctx.log("info", `Watching TCGplayer product ${id}.`)
  note(ctx, "session", "skip", "The public catalog does not require a saved session.")
  let waits = 0

  while (!ctx.signal.aborted) {
    const stock = await readOffer(ctx, id, page)
    if (stock.kind === "retry") {
      ctx.detail(stock.reason)
      ctx.log("warn", stock.reason)
      await ctx.sleep(retryWait(ctx))
      continue
    }
    if (stock.kind !== "ok") return asResult(stock)
    const offer = stock.value
    if (offer.product.title) ctx.detail(offer.product.title)
    if (!offer.inStock) {
      waits += 1
      ctx.detail(offer.reason)
      if (waits === 1 || waits % 10 === 0) ctx.log("info", offer.reason)
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }

    ctx.phase("in_stock")
    ctx.log("success", offer.reason)
    note(ctx, "monitor", "pass", offer.reason)
    if (await holdMonitorOnly(ctx)) continue
    note(ctx, "cart", "skip", "TCGAIO did not add it to the cart.")
    note(ctx, "address", "skip", "The shipping address stays on the profile.")
    note(ctx, "shipping", "skip", "Shipping is chosen in the account browser.")
    note(ctx, "payment", "skip", "The card number was not sent.")
    if (ctx.testMode) return finishTest(ctx)
    return pause(`${offer.product.title || id} is in stock. Add it in the account browser. TCGAIO did not add it to the cart or place an order.`)
  }
  return { outcome: "stopped", reason: "Stopped" }
}

async function readOffer(ctx: StoreRunContext, id: string, page: string): Promise<Step<Offer>> {
  const details = await sharedValue(ctx, monitorKey("tcgplayer", id, "details", ctx.proxy), () =>
    catalog(ctx, { method: "GET", url: detailsUrl(id), headers: catalogHeaders(page) })
  )
  if (details.kind !== "ok") return details
  if (isCatalogChallenge(details.value.status, details.value.body)) return { kind: "paused", reason: TCGPLAYER_PAUSE }
  if (details.value.status === 429 || details.value.status >= 500) {
    return { kind: "retry", reason: `Catalog request returned HTTP ${details.value.status}. Retrying.` }
  }
  if (details.value.status === 404) {
    return { kind: "ok", value: { product: { id, title: "" }, inStock: false, reason: `TCGplayer product ${id} was not found.`, seller: "" } }
  }
  const product = readProduct(details.value.body, id)
  if (!product || details.value.status >= 400) {
    return { kind: "retry", reason: `Catalog returned HTTP ${details.value.status} without a product.` }
  }

  const directOnly = (ctx.module?.soldBy ?? "retailer") !== "any"
  const listed = await catalog(ctx, {
    method: "POST",
    url: listingsUrl(id),
    headers: catalogHeaders(page, true),
    body: listingsBody(directOnly)
  })
  if (listed.kind !== "ok") return listed
  if (isCatalogChallenge(listed.value.status, listed.value.body)) return { kind: "paused", reason: TCGPLAYER_PAUSE }
  if (listed.value.status === 429 || listed.value.status >= 500) {
    return { kind: "retry", reason: `Listings request returned HTTP ${listed.value.status}. Retrying.` }
  }
  if (listed.value.status >= 400) {
    return { kind: "retry", reason: `Listings returned HTTP ${listed.value.status}. Retrying.` }
  }
  const chosen = chooseListings(readListings(listed.value.body), directOnly ? "retailer" : "any")
  const listing = chosen[0]
  const inStock = Boolean(listing)
  const price = listing?.price ?? product.marketPrice
  const seller = listing ? (listing.direct ? "TCGplayer Direct" : listing.sellerName || "Marketplace") : ""
  const priced = price !== undefined ? ` at $${price.toFixed(2)}` : ""
  const reason = inStock
    ? `${product.title || id} is in stock${listing?.direct ? " on TCGplayer Direct" : ""}${priced}.`
    : directOnly
      ? `${product.title || id} has no TCGplayer Direct listing in the public catalog.`
      : `${product.title || id} has no listing with quantity in the public catalog.`
  noteWatch(ctx, {
    inStock,
    title: product.title,
    price,
    offerId: listing?.listingId,
    seller,
    imageUrl: product.imageUrl,
    url: page
  })
  return { kind: "ok", value: { product: { ...product, marketPrice: price ?? product.marketPrice }, listing, inStock, reason, seller } }
}

async function catalog(ctx: StoreRunContext, request: HttpRequest): Promise<Step<HttpResponse>> {
  if (request.method !== "GET" && request.method !== "POST") return { kind: "failed", reason: "TCGplayer checkout is not sent from TCGAIO." }
  let host = ""
  let path = ""
  try {
    const url = new URL(request.url)
    host = url.hostname
    path = url.pathname
  } catch {
    return { kind: "failed", reason: "The TCGplayer request URL is invalid." }
  }
  if (host !== HOST) return { kind: "failed", reason: `Refusing to contact ${host}.` }
  if (request.method === "POST" && !/\/listings$/.test(path)) return { kind: "failed", reason: "TCGplayer checkout is not sent from TCGAIO." }
  if (/cart|checkout|place-order/i.test(path)) return { kind: "failed", reason: "TCGplayer checkout is not sent from TCGAIO." }
  const response = await ctx.http.request({ ...request, proxy: ctx.proxy, signal: ctx.signal })
  return { kind: "ok", value: response }
}

function catalogHeaders(referer: string, write = false): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.tcgplayer.com",
    referer,
    "user-agent": USER_AGENT
  }
  if (write) headers["content-type"] = "application/json"
  return headers
}

function fail(reason: string): StoreRunResult {
  return { outcome: "failed", reason }
}

function pause(reason: string): StoreRunResult {
  return { outcome: "paused", reason }
}

function asResult(step: StepStop): StoreRunResult {
  if (step.kind === "paused") return { outcome: "paused", reason: step.reason }
  if (step.reason === "Stopped") return { outcome: "stopped", reason: "Stopped" }
  return { outcome: "failed", reason: step.reason }
}
