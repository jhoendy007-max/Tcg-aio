import { attachSession } from "../../engine/block-recovery"
import { holdMonitorOnly, monitorKey, monitorStatusReason, noteWatch, sharedValue } from "../../engine/monitor"
import { productImage } from "../../shared/image"
import { finishTest, note } from "../../engine/test-mode"
import { redact } from "../../shared/redact"
import type { SessionCookies } from "../../shared/types"
import { chromeUserAgent } from "../../engine/chrome-ua"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import { checkoutPreflight, paceAddToCart, retryWait, type StoreModule, type StoreRunContext, type StoreRunResult } from "../module"
import { commerceCardType, readPaymentMethod, stripePaymentMethodBody } from "./card"
import {
  basketsUrl,
  bearerFromSession,
  declined,
  isChallenge,
  isGuestToken,
  isUnauthorized,
  needsShopperAction,
  ordersUrl,
  outOfStock,
  parseSku,
  productApiUrl,
  productPageUrl,
  readBasketId,
  readOrderId,
  readOrderTotal,
  readShippingMethods,
  readStock,
  readStripeKey,
  type StockReading
} from "./parse"

const STORE_HOSTS = new Set(["www.crunchyroll.com", "store.crunchyroll.com"])
const STRIPE_HOST = "api.stripe.com"

export const CRUNCHYROLL_PAUSE =
  "Crunchyroll presented a challenge (Cloudflare or a captcha). Finish it in your own browser, paste a fresh session if needed, then resume. Zzz AIO does not solve challenges."

const SESSION_PAUSE =
  "Paste a signed-in Crunchyroll Store session (the www.crunchyroll.com cookie header or the shopper access token). Password sign-in is blocked by Cloudflare, and Zzz AIO does not solve challenges."
const EXPIRED_PAUSE = "The Crunchyroll session expired. Paste a fresh cookie header or access token, then resume."
const GUEST_PAUSE = "The Crunchyroll session is a guest token. Paste the cookie header from a signed-in browser, then resume."

class CookieJar {
  private cookies = new Map<string, string>()
  bearer = ""

  load(session?: SessionCookies): void {
    if (session?.cookie) this.merge(session.cookie)
    this.bearer = bearerFromSession(session?.accessToken, session?.cookie) ?? ""
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
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

export function createCrunchyrollModule(): StoreModule {
  return {
    id: "crunchyroll",
    displayName: "Crunchyroll",
    skuHint: "Product ID or URL",
    implemented: true,
    run: (ctx) => runCrunchyroll(ctx)
  }
}

async function runCrunchyroll(ctx: StoreRunContext): Promise<StoreRunResult> {
  const sku = parseSku(ctx.task.sku)
  if (!sku) return fail("Enter a Crunchyroll product ID or a store.crunchyroll.com product URL.")
  if (ctx.profile.shipping.country !== "US") return fail("v1 places US ship-to-home orders only.")
  const jar = new CookieJar()
  if (!ctx.monitorOnly) {
    if (ctx.account.store !== "crunchyroll") return fail("Choose a Crunchyroll account.")
    if (!ctx.account.session?.cookie && !ctx.account.session?.accessToken) return pause(SESSION_PAUSE)
    const bearer = bearerFromSession(ctx.account.session.accessToken, ctx.account.session.cookie)
    if (bearer && isGuestToken(bearer)) return pause(GUEST_PAUSE)
    jar.load(ctx.account.session)
    attachSession(ctx, (cookies) => jar.load(cookies))
    ctx.log("info", "Using the saved Crunchyroll session. store.crunchyroll.com now redirects to www.crunchyroll.com.")
    note(ctx, "session", "pass", "Saved Crunchyroll session loaded.")
  } else {
    note(ctx, "session", "skip", "Monitors check stock without a store account.")
  }
  ctx.phase("monitoring")
  ctx.log("info", `Watching product ${sku} for Crunchyroll store availability.`)
  let waits = 0

  while (!ctx.signal.aborted) {
    const stock = await readOffer(ctx, jar, sku)
    if (stock.kind === "retry") {
      ctx.detail(stock.reason)
      ctx.log("warn", stock.reason)
      await ctx.sleep(retryWait(ctx))
      continue
    }
    if (stock.kind !== "ok") return asResult(stock)
    const reading = stock.value
    if (reading.title) ctx.detail(reading.title)
    if (!reading.inStock) {
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
    const preflight = checkoutPreflight(ctx, reading.price)
    if (preflight) return preflight
    await paceAddToCart(ctx)
    ctx.phase("adding_to_cart")
    const cart = await addToCart(ctx, jar, sku)
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
    note(ctx, "cart", "pass", "Added the item to the cart.")

    ctx.phase("checking_out")
    const shipped = await shipToHome(ctx, jar, cart.value)
    if (shipped.kind !== "ok") {
      note(ctx, "address", "fail", shipped.reason)
      return asResult(shipped)
    }
    note(ctx, "address", "pass", "Shipping address accepted.")
    note(ctx, "shipping", "pass", "Shipping method selected.")
    ctx.log("info", `Submitting payment for the card ending ${ctx.profile.last4}.`)
    const paid = await pay(ctx, jar, sku, cart.value, shipped.value)
    if (paid.kind === "tested") return finishTest(ctx)
    if (paid.kind !== "ok") return asResult(paid)
    return {
      outcome: "success",
      orderId: paid.value,
      detail: paid.value ? `Order ${paid.value}` : "Crunchyroll accepted the shipping order."
    }
  }
  return { outcome: "stopped", reason: "Stopped" }
}

async function readOffer(ctx: StoreRunContext, jar: CookieJar, sku: string): Promise<Step<StockReading>> {
  const response = await sharedValue(ctx, monitorKey("crunchyroll", sku, "product", ctx.proxy), () => store(ctx, { method: "GET", url: productApiUrl(sku), headers: apiHeaders(jar, productPageUrl(sku)) }))
  if (response.kind !== "ok") return response
  const blocked = monitorStatusReason(response.value.status, Boolean(ctx.proxy))
  if (blocked) return { kind: "retry", reason: blocked }
  const reading = readStock(response.value.body, sku)
  if (reading) {
    reading.imageUrl = productImage(response.value.body) || undefined
    noteWatch(ctx, { ...reading, url: productPageUrl(sku) })
    return { kind: "ok", value: reading }
  }
  if (response.value.status === 404) {
    return { kind: "ok", value: { inStock: false, status: "NOT_FOUND", sku, reason: "Product was not found." } }
  }
  return { kind: "retry", reason: `Monitor returned HTTP ${response.value.status} without a stock reading.` }
}

async function addToCart(ctx: StoreRunContext, jar: CookieJar, sku: string): Promise<Step<string>> {
  const created = await store(ctx, {
    method: "POST",
    url: basketsUrl("/baskets?siteId=CrunchyrollUS"),
    headers: apiHeaders(jar, productPageUrl(sku)),
    body: JSON.stringify({ productItems: [{ productId: sku, quantity: ctx.task.quantity }] })
  })
  if (created.kind !== "ok") return created
  let basketId = readBasketId(created.value.body)
  if ((!basketId || created.value.status === 400 || created.value.status === 409) && outOfStock(created.value.body)) {
    return { kind: "oos", reason: "Out of stock" }
  }
  if (!basketId && (created.value.status === 400 || created.value.status === 409)) {
    basketId = readBasketId(created.value.body)
  }
  if (!basketId) {
    return { kind: "failed", reason: `Crunchyroll did not return a basket (${created.value.status}): ${snippet(created.value.body)}` }
  }
  if (created.value.status < 200 || created.value.status >= 300) {
    const added = await store(ctx, {
      method: "POST",
      url: basketsUrl(`/baskets/${encodeURIComponent(basketId)}/items?siteId=CrunchyrollUS`),
      headers: apiHeaders(jar, productPageUrl(sku)),
      body: JSON.stringify([{ productId: sku, quantity: ctx.task.quantity }])
    })
    if (added.kind !== "ok") return added
    if (outOfStock(added.value.body)) return { kind: "oos", reason: "Out of stock" }
    if (added.value.status < 200 || added.value.status >= 300) {
      return { kind: "failed", reason: `Add to cart was rejected (${added.value.status}): ${snippet(added.value.body)}` }
    }
  }
  ctx.log("success", "Added to the Crunchyroll basket.")
  return { kind: "ok", value: basketId }
}

async function shipToHome(ctx: StoreRunContext, jar: CookieJar, basketId: string): Promise<Step<number | undefined>> {
  const page = "https://www.crunchyroll.com/store/checkout"
  const shipping = ctx.profile.shipping
  const customer = await store(ctx, {
    method: "PUT",
    url: basketsUrl(`/baskets/${encodeURIComponent(basketId)}/customer?siteId=CrunchyrollUS`),
    headers: apiHeaders(jar, page),
    body: JSON.stringify({ email: ctx.profile.email })
  })
  if (customer.kind !== "ok") return customer
  if (customer.value.status < 200 || customer.value.status >= 300) {
    return { kind: "failed", reason: `Checkout email was rejected (${customer.value.status}): ${snippet(customer.value.body)}` }
  }
  const addressed = await store(ctx, {
    method: "PUT",
    url: basketsUrl(`/baskets/${encodeURIComponent(basketId)}/shipments/me/shipping-address?siteId=CrunchyrollUS`),
    headers: apiHeaders(jar, page),
    body: JSON.stringify({
      firstName: shipping.firstName,
      lastName: shipping.lastName,
      address1: shipping.line1,
      address2: shipping.line2,
      city: shipping.city,
      stateCode: shipping.state,
      postalCode: shipping.zip,
      countryCode: "US",
      phone: ctx.profile.phone
    })
  })
  if (addressed.kind !== "ok") return addressed
  if (addressed.value.status < 200 || addressed.value.status >= 300) {
    return { kind: "failed", reason: `Shipping address was rejected (${addressed.value.status}): ${snippet(addressed.value.body)}` }
  }
  let methods = readShippingMethods(addressed.value.body)
  let total = readOrderTotal(addressed.value.body)
  if (!methods.length) {
    const listed = await store(ctx, {
      method: "GET",
      url: basketsUrl(`/baskets/${encodeURIComponent(basketId)}/shipments/me/shipping-methods?siteId=CrunchyrollUS`),
      headers: apiHeaders(jar, page)
    })
    if (listed.kind !== "ok") return listed
    if (listed.value.status < 200 || listed.value.status >= 300) {
      return { kind: "failed", reason: `Shipping methods were rejected (${listed.value.status}): ${snippet(listed.value.body)}` }
    }
    methods = readShippingMethods(listed.value.body)
    total = total ?? readOrderTotal(listed.value.body)
  }
  const choice = methods.find((method) => !method.pickup)
  if (!choice) {
    if (methods.some((method) => method.pickup)) {
      return { kind: "failed", reason: "Crunchyroll is not offering ship-to-home for this item. v1 does not place pickup orders." }
    }
    return { kind: "failed", reason: "Crunchyroll did not return a shipping method." }
  }
  const selected = await store(ctx, {
    method: "PUT",
    url: basketsUrl(`/baskets/${encodeURIComponent(basketId)}/shipments/me/shipping-method?siteId=CrunchyrollUS`),
    headers: apiHeaders(jar, page),
    body: JSON.stringify({ id: choice.id })
  })
  if (selected.kind !== "ok") return selected
  if (selected.value.status < 200 || selected.value.status >= 300) {
    return { kind: "failed", reason: `Shipping method was rejected (${selected.value.status}): ${snippet(selected.value.body)}` }
  }
  ctx.log("info", `Shipping with ${choice.name}.`)
  return { kind: "ok", value: readOrderTotal(selected.value.body) ?? total }
}

async function pay(ctx: StoreRunContext, jar: CookieJar, sku: string, basketId: string, total: number | undefined): Promise<Step<string | undefined>> {
  const page = await store(ctx, {
    method: "GET",
    url: productPageUrl(sku),
    headers: pageHeaders(jar, "https://www.crunchyroll.com/store")
  })
  if (page.kind !== "ok") return page
  const key = readStripeKey(page.value.body)
  if (!key) return { kind: "failed", reason: "Crunchyroll did not return a Stripe publishable key." }
  const billing = ctx.profile.billing
  const tokenResponse = await stripeCall(ctx, {
    method: "POST",
    url: "https://api.stripe.com/v1/payment_methods",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": chromeUserAgent()
    },
    body: stripePaymentMethodBody({
      number: ctx.profile.card.number,
      cvc: ctx.profile.card.cvv,
      expMonth: ctx.profile.card.expMonth,
      expYear: ctx.profile.card.expYear,
      name: ctx.profile.card.name,
      line1: billing.line1,
      city: billing.city,
      state: billing.state,
      postalCode: billing.zip
    })
  })
  if (isChallenge(tokenResponse.status, tokenResponse.body, header(tokenResponse, "cf-mitigated"))) {
    return { kind: "paused", reason: CRUNCHYROLL_PAUSE }
  }
  if (needsShopperAction(tokenResponse.body)) return { kind: "paused", reason: CRUNCHYROLL_PAUSE }
  if (declined(tokenResponse.body)) return { kind: "failed", reason: "Stripe declined the card." }
  const method = readPaymentMethod(tokenResponse.body)
  if (!method || tokenResponse.status < 200 || tokenResponse.status >= 300) {
    return { kind: "failed", reason: `Stripe rejected the card token (${tokenResponse.status}).` }
  }
  const instrument: Record<string, unknown> = {
    paymentMethodId: "STRIPE",
    c_stripePaymentMethodId: method.id,
    paymentCard: {
      cardType: commerceCardType(ctx.profile.card.number),
      expirationMonth: method.expMonth,
      expirationYear: method.expYear,
      holder: ctx.profile.card.name,
      maskedNumber: `************${method.last4}`
    }
  }
  if (total !== undefined) instrument.amount = total
  const saved = await store(ctx, {
    method: "POST",
    url: basketsUrl(`/baskets/${encodeURIComponent(basketId)}/payment-instruments?siteId=CrunchyrollUS`),
    headers: apiHeaders(jar, "https://www.crunchyroll.com/store/checkout"),
    body: JSON.stringify(instrument)
  })
  if (saved.kind !== "ok") return saved
  if (needsShopperAction(saved.value.body)) return { kind: "paused", reason: CRUNCHYROLL_PAUSE }
  if (declined(saved.value.body)) return { kind: "failed", reason: "Crunchyroll declined the card." }
  if (saved.value.status < 200 || saved.value.status >= 300) {
    return { kind: "failed", reason: `Payment was rejected (${saved.value.status}): ${snippet(saved.value.body)}` }
  }
  note(ctx, "payment", "pass", "Stripe token saved on the basket. The card was not charged.")
  if (ctx.testMode) {
    if (ctx.clearCartAfterTest) note(ctx, "cart", "skip", "Crunchyroll cart clear is left for you. Test mode does not call a cart-delete API.")
    return { kind: "tested", reason: "Test mode" }
  }
  const order = await store(ctx, {
    method: "POST",
    url: ordersUrl(),
    headers: apiHeaders(jar, "https://www.crunchyroll.com/store/checkout"),
    body: JSON.stringify({ basketId })
  })
  if (order.kind !== "ok") return order
  if (outOfStock(order.value.body)) return { kind: "failed", reason: "Crunchyroll reported unavailable stock after the order request. The request was not retried; verify your account before starting again." }
  if (needsShopperAction(order.value.body)) return { kind: "paused", reason: CRUNCHYROLL_PAUSE }
  if (declined(order.value.body)) return { kind: "failed", reason: "Crunchyroll declined the card." }
  const orderId = readOrderId(order.value.body)
  if (order.value.status >= 200 && order.value.status < 300 && orderId) {
    ctx.log("success", "Crunchyroll accepted the order.")
    return { kind: "ok", value: orderId }
  }
  return { kind: "failed", reason: `Checkout failed (${order.value.status}): ${snippet(order.value.body)}` }
}

async function store(ctx: StoreRunContext, request: HttpRequest): Promise<Step<HttpResponse>> {
  const response = await send(ctx, request)
  if (isChallenge(response.status, response.body, header(response, "cf-mitigated"))) {
    return { kind: "paused", reason: CRUNCHYROLL_PAUSE }
  }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  return { kind: "ok", value: response }
}

async function send(ctx: StoreRunContext, request: HttpRequest): Promise<HttpResponse> {
  const host = new URL(request.url).hostname
  if (!STORE_HOSTS.has(host)) throw new Error(`Refusing to contact ${host}.`)
  return ctx.http.request({ ...request, redirect: "manual", proxy: ctx.proxy, signal: ctx.signal })
}

async function stripeCall(ctx: StoreRunContext, request: HttpRequest): Promise<HttpResponse> {
  const host = new URL(request.url).hostname
  if (host !== STRIPE_HOST) throw new Error("Card data can only be sent to api.stripe.com.")
  return ctx.http.request({ ...request, proxy: ctx.proxy, signal: ctx.signal })
}

function apiHeaders(jar: CookieJar, referer: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.crunchyroll.com",
    referer,
    "user-agent": chromeUserAgent()
  }
  const cookie = jar.header()
  if (cookie) headers.cookie = cookie
  if (jar.bearer) headers.authorization = `Bearer ${jar.bearer}`
  return headers
}

function pageHeaders(jar: CookieJar, referer: string): Record<string, string> {
  const headers = apiHeaders(jar, referer)
  headers.accept = "text/html,application/xhtml+xml"
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
