import { attachSession } from "../../engine/block-recovery"
import { holdMonitorOnly, monitorKey, noteWatch, sharedValue } from "../../engine/monitor"
import { productImage } from "../../shared/image"
import { finishTest, note } from "../../engine/test-mode"
import { redact } from "../../shared/redact"
import type { SessionCookies } from "../../shared/types"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import type { StoreModule, StoreRunContext, StoreRunResult } from "../module"
import {
  asksForCard,
  asksForCvv,
  cardField,
  isChallenge,
  isSignIn,
  isSignedInCookie,
  isTwoFactor,
  offersUrl,
  outOfStock,
  parseAsin,
  pickupOnly,
  productUrl,
  readOrderId,
  readOtpForm,
  readPlaceOrder,
  readStock,
  type StockReading
} from "./parse"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const HOST = "www.amazon.com"

export const AMAZON_PAUSE =
  "Amazon presented a robot check or captcha. Finish it in your own browser, paste a fresh session if needed, then resume. TCGAIO does not solve challenges."
const TWO_FA_PAUSE = "Amazon asked for a two-step verification code. Approve it in your own browser, paste a fresh session if needed, then resume. TCGAIO does not solve challenges."
const CVV_PAUSE = "Amazon asked for the card security code. Finish checkout in your browser. TCGAIO does not send card numbers or CVVs."
const SESSION_PAUSE = "Paste a signed-in Amazon cookie header from www.amazon.com, including at-main. Password sign-in is not attempted."
const EXPIRED_PAUSE = "The Amazon session expired. Paste a fresh www.amazon.com cookie header, then resume."

class CookieJar {
  private cookies = new Map<string, string>()

  load(session?: SessionCookies): void {
    if (session?.cookie) this.merge(session.cookie)
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
  }

  absorb(response: HttpResponse): void {
    const raw = response.headers["set-cookie"]
    const lines = Array.isArray(raw) ? raw : raw ? [raw] : []
    for (const line of lines) this.merge(line.split(";")[0] ?? "")
  }

  private merge(header: string): void {
    for (const part of header.split(/;\s*/)) {
      const eq = part.indexOf("=")
      if (eq <= 0) continue
      this.cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  }
}

interface StepOk<T> {
  kind: "ok"
  value: T
}
interface StepStop {
  kind: "paused" | "failed" | "oos" | "unauthorized" | "retry" | "tested"
  reason: string
}
type Step<T> = StepOk<T> | StepStop

export function createAmazonModule(): StoreModule {
  return {
    id: "amazon",
    displayName: "Amazon",
    skuHint: "ASIN or product URL",
    implemented: true,
    run: (ctx) => runAmazon(ctx)
  }
}

async function runAmazon(ctx: StoreRunContext): Promise<StoreRunResult> {
  const asin = parseAsin(ctx.task.sku)
  if (!asin) return fail("Enter an Amazon ASIN or an amazon.com product URL.")
  if (ctx.profile.shipping.country !== "US") return fail("v1 places US ship-to-home orders only.")
  if (ctx.account.store !== "amazon") return fail("Choose an Amazon account.")
  if (!isSignedInCookie(ctx.account.session?.cookie)) return pause(SESSION_PAUSE)

  const jar = new CookieJar()
  jar.load(ctx.account.session)
  attachSession(ctx, (cookies) => jar.load(cookies))
  ctx.log("info", "Using the saved Amazon session. Checkout uses the address and payment already saved on the account.")
  note(ctx, "session", "pass", "Saved Amazon session loaded.")
  ctx.phase("monitoring")
  ctx.log("info", `Watching ${asin} for an offer sold and shipped by Amazon.com.`)
  let waits = 0

  while (!ctx.signal.aborted) {
    const stock = await readOffer(ctx, jar, asin)
    if (stock.kind === "retry") {
      ctx.detail(stock.reason)
      ctx.log("warn", stock.reason)
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (stock.kind !== "ok") return asResult(stock)
    const reading = stock.value
    if (reading.title) ctx.detail(reading.title)
    if (!reading.inStock || !reading.offerListingId) {
      waits += 1
      ctx.detail(reading.reason)
      if (waits === 1 || waits % 10 === 0) ctx.log("info", reading.reason)
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }

    ctx.phase("in_stock")
    ctx.log("success", reading.reason)
    note(ctx, "monitor", "pass", reading.reason)
    if (await holdMonitorOnly(ctx)) continue
    ctx.phase("adding_to_cart")
    const cart = await addToCart(ctx, jar, asin, reading)
    if (cart.kind === "oos") {
      ctx.log("warn", "Add to cart reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (cart.kind !== "ok") {
      note(ctx, "cart", "fail", cart.reason)
      return asResult(cart)
    }
    note(ctx, "cart", "pass", "Added the Amazon.com offer to the cart.")

    ctx.phase("checking_out")
    ctx.log("info", "Checking out with the address and payment saved on the Amazon account.")
    const placed = await placeOrder(ctx, jar)
    if (placed.kind === "tested") return finishTest(ctx)
    if (placed.kind === "oos") {
      ctx.log("warn", "Checkout reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (placed.kind !== "ok") return asResult(placed)
    return {
      outcome: "success",
      orderId: placed.value,
      detail: placed.value ? `Order ${placed.value}` : "Amazon accepted the shipping order."
    }
  }
  return { outcome: "stopped", reason: "Stopped" }
}

async function readOffer(ctx: StoreRunContext, jar: CookieJar, asin: string): Promise<Step<StockReading>> {
  const offers = await sharedValue(ctx, monitorKey("amazon", asin, "offers", ctx.proxy), () => amazon(ctx, jar, {
    method: "GET",
    url: offersUrl(asin),
    headers: pageHeaders(jar, productUrl(asin), true)
  }))
  if (offers.kind !== "ok") return offers
  if (offers.value.status === 429 || offers.value.status >= 500) {
    return { kind: "retry", reason: `Offer request returned HTTP ${offers.value.status}. Retrying.` }
  }
  const offerHtml = offers.value.status === 200 ? offers.value.body : ""
  const offersUseful = /aod-offer|aod-pinned|aod-offer-soldBy/i.test(offerHtml)
  let productHtml = ""
  if (!offersUseful) {
    const page = await sharedValue(ctx, monitorKey("amazon", asin, "page", ctx.proxy), () => amazon(ctx, jar, { method: "GET", url: productUrl(asin), headers: pageHeaders(jar, "https://www.amazon.com/") }))
    if (page.kind !== "ok") return page
    if (page.value.status === 429 || page.value.status >= 500) {
      return { kind: "retry", reason: `Monitor request returned HTTP ${page.value.status}. Retrying.` }
    }
    productHtml = page.value.body
  }
  const reading = readStock(productHtml, offerHtml, asin)
  reading.imageUrl = productImage(productHtml) || productImage(offerHtml) || undefined
  noteWatch(ctx, { ...reading, url: productUrl(asin) })
  return { kind: "ok", value: reading }
}

async function addToCart(ctx: StoreRunContext, jar: CookieJar, asin: string, reading: StockReading): Promise<Step<true>> {
  const params = new URLSearchParams()
  if (reading.csrf) params.set("anti-csrftoken-a2z", reading.csrf)
  params.set("items[0.base][asin]", asin)
  params.set("items[0.base][offerListingId]", reading.offerListingId ?? "")
  params.set("items[0.base][quantity]", String(ctx.task.quantity))
  params.set("clientName", "OffersX_AllOffersDisplay_DetailPage")
  params.set("submit.addToCart", "Add to Cart")
  const headers = pageHeaders(jar, productUrl(asin))
  headers["content-type"] = "application/x-www-form-urlencoded"
  if (reading.csrf) headers["anti-csrftoken-a2z"] = reading.csrf
  const added = await amazon(ctx, jar, {
    method: "POST",
    url: "https://www.amazon.com/cart/add-to-cart/ref=aod_dpdsk_new_0",
    headers,
    body: params.toString()
  }, true)
  if (added.kind !== "ok") return added
  if (outOfStock(added.value.body)) return { kind: "oos", reason: "Out of stock" }
  if (added.value.status < 200 || added.value.status >= 400) {
    return { kind: "failed", reason: `Add to cart was rejected (${added.value.status}): ${snippet(added.value.body)}` }
  }
  ctx.log("success", "Added the Amazon.com offer to the cart.")
  return { kind: "ok", value: true }
}

async function placeOrder(ctx: StoreRunContext, jar: CookieJar): Promise<Step<string | undefined>> {
  const checkout = await amazon(ctx, jar, {
    method: "GET",
    url: "https://www.amazon.com/checkout/entry/cart?proceedToCheckout=1&pipelineType=Chewbacca&referrer=cart",
    headers: pageHeaders(jar, "https://www.amazon.com/gp/cart/view.html")
  }, true)
  if (checkout.kind !== "ok") return checkout
  if (outOfStock(checkout.value.body)) return { kind: "oos", reason: "Out of stock" }
  if (pickupOnly(checkout.value.body)) {
    return { kind: "failed", reason: "Amazon is not offering ship-to-home for this cart. v1 does not place pickup orders." }
  }
  if (asksForCvv(checkout.value.body)) return { kind: "paused", reason: CVV_PAUSE }
  if (asksForCard(checkout.value.body)) {
    return { kind: "failed", reason: "Amazon has no saved payment method on this account. Add one in your browser. TCGAIO does not send card numbers." }
  }
  const form = readPlaceOrder(checkout.value.body)
  if (!form) return { kind: "failed", reason: `Amazon did not return a place-order form (${checkout.value.status}).` }
  if (cardField(form.fields)) return { kind: "paused", reason: CVV_PAUSE }
  note(ctx, "address", "pass", "Amazon checkout returned the saved address.")
  note(ctx, "shipping", "pass", "Ship-to-home is available.")
  note(ctx, "payment", "pass", "The saved Amazon payment method is present. No card number was sent.")
  if (ctx.testMode) {
    if (ctx.clearCartAfterTest) note(ctx, "cart", "skip", "Amazon cart clear is left on the account. Test mode does not call a cart-delete API.")
    return { kind: "tested", reason: "Test mode" }
  }
  const action = new URL(form.action || "/checkout/p/spc/place-order", "https://www.amazon.com")
  if (action.hostname !== HOST) return { kind: "failed", reason: "Amazon place-order left www.amazon.com." }
  const headers = pageHeaders(jar, "https://www.amazon.com/checkout/entry/cart")
  headers["content-type"] = "application/x-www-form-urlencoded"
  const placed = await amazon(ctx, jar, {
    method: "POST",
    url: action.toString(),
    headers,
    body: new URLSearchParams(form.fields).toString()
  }, true)
  if (placed.kind !== "ok") return placed
  if (outOfStock(placed.value.body)) return { kind: "oos", reason: "Out of stock" }
  if (asksForCvv(placed.value.body) || cardField(readPlaceOrder(placed.value.body)?.fields ?? {})) return { kind: "paused", reason: CVV_PAUSE }
  const declined = /payment was declined|card was declined|payment declined/i.test(placed.value.body)
  if (declined) return { kind: "failed", reason: "Amazon declined the saved payment method." }
  const orderId = readOrderId(placed.value.body)
  if (placed.value.status >= 200 && placed.value.status < 400 && (orderId || /order has been placed/i.test(placed.value.body))) {
    ctx.log("success", "Amazon accepted the order.")
    return { kind: "ok", value: orderId }
  }
  return { kind: "failed", reason: `Checkout failed (${placed.value.status}): ${snippet(placed.value.body)}` }
}

async function amazon(ctx: StoreRunContext, jar: CookieJar, request: HttpRequest, follow = false): Promise<Step<HttpResponse>> {
  let response = await send(ctx, request)
  jar.absorb(response)
  if (isTwoFactor(response.body, header(response, "location"))) {
    const posted = await submitOwnCode(ctx, jar, response.body)
    if (posted) {
      response = posted
      jar.absorb(response)
    }
  }
  const stopped = classify(response)
  if (stopped) return stopped
  if (!follow || response.status < 300 || response.status >= 400) return { kind: "ok", value: response }
  const location = header(response, "location")
  if (!location) return { kind: "ok", value: response }
  const next = new URL(location, request.url)
  if (next.hostname !== HOST) return { kind: "failed", reason: `Amazon redirected to ${next.hostname}.` }
  const again = await send(ctx, { method: "GET", url: next.toString(), headers: pageHeaders(jar, request.url) })
  jar.absorb(again)
  if (isTwoFactor(again.body, header(again, "location"))) {
    const posted = await submitOwnCode(ctx, jar, again.body)
    if (posted) {
      jar.absorb(posted)
      const postedStop = classify(posted)
      if (postedStop) return postedStop
      return { kind: "ok", value: posted }
    }
  }
  const againStopped = classify(again)
  if (againStopped) return againStopped
  return { kind: "ok", value: again }
}

async function submitOwnCode(ctx: StoreRunContext, jar: CookieJar, body: string): Promise<HttpResponse | null> {
  const form = readOtpForm(body)
  if (!form || !ctx.mailCode) return null
  const code = await ctx.mailCode()
  if (!code || !/^\d{4,8}$/.test(code)) return null
  let action: URL
  try {
    action = new URL(form.action, "https://www.amazon.com/")
  } catch {
    return null
  }
  if (action.hostname !== HOST) return null
  const fields = { ...form.fields, [form.field]: code }
  const headers = pageHeaders(jar, "https://www.amazon.com/")
  headers["content-type"] = "application/x-www-form-urlencoded"
  ctx.log("info", "Filled the verification code from your mailbox.")
  return send(ctx, {
    method: "POST",
    url: action.toString(),
    headers,
    body: new URLSearchParams(fields).toString()
  })
}

function classify(response: HttpResponse): StepStop | undefined {
  const location = header(response, "location")
  if (isChallenge(response.status, response.body, location)) return { kind: "paused", reason: AMAZON_PAUSE }
  if (isTwoFactor(response.body, location)) return { kind: "paused", reason: TWO_FA_PAUSE }
  if (isSignIn(response.body, location)) return { kind: "unauthorized", reason: "Unauthorized" }
  return undefined
}

async function send(ctx: StoreRunContext, request: HttpRequest): Promise<HttpResponse> {
  const host = new URL(request.url).hostname
  if (host !== HOST) throw new Error(`Refusing to contact ${host}.`)
  return ctx.http.request({ ...request, redirect: "manual", proxy: ctx.proxy, signal: ctx.signal })
}

function pageHeaders(jar: CookieJar, referer: string, ajax = false): Record<string, string> {
  const headers: Record<string, string> = {
    accept: ajax ? "text/html,*/*" : "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
    referer,
    "user-agent": USER_AGENT
  }
  const cookie = jar.header()
  if (cookie) headers.cookie = cookie
  if (ajax) headers["x-requested-with"] = "XMLHttpRequest"
  return headers
}

function header(response: HttpResponse, name: string): string {
  const value = response.headers[name] ?? response.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

function snippet(body: string): string {
  return redact(body).replace(/\s+/g, " ").slice(0, 240)
}

function fail(reason: string): StoreRunResult {
  return { outcome: "failed", reason }
}

function pause(reason: string): StoreRunResult {
  return { outcome: "paused", reason }
}

function asResult(step: StepStop): StoreRunResult {
  if (step.kind === "paused") return { outcome: "paused", reason: step.reason }
  if (step.kind === "unauthorized") return pause(EXPIRED_PAUSE)
  if (step.reason === "Stopped") return { outcome: "stopped", reason: "Stopped" }
  return { outcome: "failed", reason: step.reason }
}
