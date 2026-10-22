import { holdMonitorOnly, monitorKey, monitorStatusReason, noteWatch, sharedValue } from "../../engine/monitor"
import { note } from "../../engine/test-mode"
import { chromeUserAgent } from "../../engine/chrome-ua"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import { retryWait, type StoreModule, type StoreRunContext, type StoreRunResult } from "../module"
import { checkoutCopy, checkoutLang } from "../page/copy"
import { checkoutFromPage } from "../page/flow"
import { PageCookies } from "../page/jar"
import { isLoginWall, isPageChallenge } from "../page/parse"
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

const HOST = "mp-search-api.tcgplayer.com"
const SHOP = "www.tcgplayer.com"

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
  if (!ctx.monitorOnly && ctx.account.store !== "tcgplayer") return fail("Choose a TCGplayer account.")
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
    const copy = checkoutCopy(checkoutLang(ctx.settings.language))
    if (!ctx.account.session?.cookie && !ctx.account.session?.accessToken) return pause(copy.needSession("TCGplayer"))
    const jar = new PageCookies()
    jar.load(ctx.account.session)
    const shopPage = await shop(ctx, jar, { method: "GET", url: page, headers: shopHeaders(jar, page) })
    if (shopPage.kind !== "ok") return asResult(shopPage)
    if (isPageChallenge(shopPage.value.status, shopPage.value.body) || isCatalogChallenge(shopPage.value.status, shopPage.value.body)) {
      return pause(copy.challenge("TCGplayer"))
    }
    if (shopPage.value.status === 401 || isLoginWall(shopPage.value.body)) return pause(copy.notSignedIn("TCGplayer"))
    if (shopPage.value.status === 429 || shopPage.value.status >= 500) {
      ctx.detail(`TCGplayer checkout page returned HTTP ${shopPage.value.status}. Retrying.`)
      await ctx.sleep(retryWait(ctx))
      continue
    }
    const bought = await checkoutFromPage(
      ctx,
      { id: "tcgplayer", name: "TCGplayer", host: SHOP },
      page,
      shopPage.value.body,
      offer.product.title || id,
      id,
      offer.product.marketPrice,
      {
        request: async (method, url, referer, body) => {
          const result = await shop(ctx, jar, shopCall(jar, method, url, referer, body))
          if (result.kind === "ok") return result
          return { kind: result.kind === "paused" ? "paused" : "failed", reason: result.reason }
        }
      }
    )
    if (bought.outcome === "oos") {
      ctx.log("warn", bought.reason)
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    return bought
  }
  return { outcome: "stopped", reason: "Stopped" }
}

async function readOffer(ctx: StoreRunContext, id: string, page: string): Promise<Step<Offer>> {
  const details = await sharedValue(ctx, monitorKey("tcgplayer", id, "details", ctx.proxy), () =>
    catalog(ctx, { method: "GET", url: detailsUrl(id), headers: catalogHeaders(page) })
  )
  if (details.kind !== "ok") return details
  if (isCatalogChallenge(details.value.status, details.value.body)) return { kind: "paused", reason: TCGPLAYER_PAUSE }
  const blocked = monitorStatusReason(details.value.status, Boolean(ctx.proxy))
  if (blocked) return { kind: "retry", reason: blocked }
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
  const listingsBlocked = monitorStatusReason(listed.value.status, Boolean(ctx.proxy))
  if (listingsBlocked) return { kind: "retry", reason: listingsBlocked }
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

async function shop(ctx: StoreRunContext, jar: PageCookies, request: HttpRequest): Promise<Step<HttpResponse>> {
  if (request.method !== "GET" && request.method !== "POST") return { kind: "failed", reason: "TCGplayer checkout is not sent from TCGAIO." }
  let host = ""
  try {
    host = new URL(request.url).hostname.toLowerCase()
  } catch {
    return { kind: "failed", reason: "The TCGplayer request URL is invalid." }
  }
  if (host !== SHOP || host.includes("ecom-api")) return { kind: "failed", reason: `Refusing to contact ${host}.` }
  const response = await ctx.http.request({ ...request, proxy: ctx.proxy, signal: ctx.signal, redirect: "manual" })
  if (jar.absorb(response.headers) && ctx.account.id) {
    await ctx.onSession({
      accessToken: ctx.account.session?.accessToken || "session",
      visitorId: ctx.account.session?.visitorId,
      refreshToken: ctx.account.session?.refreshToken,
      idToken: ctx.account.session?.idToken,
      cookie: jar.header()
    })
  }
  return { kind: "ok", value: response }
}

function shopCall(jar: PageCookies, method: "GET" | "POST", url: string, referer: string, body?: string): HttpRequest {
  const headers = shopHeaders(jar, referer)
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded"
    headers.origin = `https://${SHOP}`
  }
  return { method, url, headers, body, redirect: "manual" }
}

function shopHeaders(jar: PageCookies, referer: string): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/json",
    "accept-language": "en-US,en;q=0.9",
    referer,
    "user-agent": chromeUserAgent(),
    cookie: jar.header()
  }
}

function catalogHeaders(referer: string, write = false): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.tcgplayer.com",
    referer,
    "user-agent": chromeUserAgent()
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
