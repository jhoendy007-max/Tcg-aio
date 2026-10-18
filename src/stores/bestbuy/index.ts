import { randomBytes } from "node:crypto"
import { attachSession } from "../../engine/block-recovery"
import { holdMonitorOnly, monitorKey, noteWatch, sharedCall } from "../../engine/monitor"
import { productImage } from "../../shared/image"
import { finishTest, note } from "../../engine/test-mode"
import { redact } from "../../shared/redact"
import type { SessionCookies } from "../../shared/types"
import { chromeUserAgent } from "../../engine/chrome-ua"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import { paceAddToCart, retryWait, type StoreModule, type StoreRunContext, type StoreRunResult } from "../module"
import { encryptBestBuyPan } from "./card"
import {
  decodeQueueSeconds,
  isChallenge,
  isGuestCart,
  isThreeDSecure,
  isUnauthorized,
  monitorUrl,
  parseSku,
  readOrderDetails,
  readQueue,
  readStock,
  type OrderDetails,
  type StockReading
} from "./parse"

const HOST = "www.bestbuy.com"
const QUEUE_ATTEMPTS = 8

export const BESTBUY_PAUSE =
  "Best Buy presented a challenge (Akamai, a captcha, or card authentication). Finish it in your own browser, paste a fresh session if needed, then resume. TCGAIO does not solve challenges."

const SESSION_PAUSE = "Paste a signed-in Best Buy browser session (the cookie header from www.bestbuy.com). Password sign-in is blocked by Akamai, and TCGAIO does not solve challenges."
const EXPIRED_PAUSE = "The Best Buy session expired. Paste a fresh cookie header, then resume."
const GUEST_PAUSE = "The Best Buy session is not signed in. Paste the cookie header from a signed-in browser, then resume."

class CookieJar {
  accessToken = ""
  visitorId = ""
  raw = ""

  load(session?: SessionCookies): void {
    this.accessToken = session?.accessToken ?? ""
    this.visitorId = session?.visitorId ?? ""
    this.raw = session?.cookie ?? ""
  }

  header(): string {
    if (this.raw) return this.raw
    const parts: string[] = []
    if (this.accessToken) parts.push(`at=${this.accessToken}`)
    if (this.visitorId) parts.push(`vt=${this.visitorId}`)
    return parts.join("; ")
  }
}

interface StepOk<T> {
  kind: "ok"
  value: T
}
interface StepStop {
  kind: "paused" | "failed" | "oos" | "unauthorized" | "retry"
  reason: string
}
type Step<T> = StepOk<T> | StepStop

export function createBestBuyModule(): StoreModule {
  return {
    id: "bestbuy",
    displayName: "Best Buy",
    skuHint: "SKU or product URL",
    implemented: true,
    run: (ctx) => runBestBuy(ctx)
  }
}

async function runBestBuy(ctx: StoreRunContext): Promise<StoreRunResult> {
  const sku = parseSku(ctx.task.sku)
  if (!sku) return fail("Enter a Best Buy SKU or a product URL that contains /sku/.")
  if (ctx.profile.shipping.country !== "US") return fail("v1 places US ship-to-home orders only.")
  if (ctx.account.store !== "bestbuy") return fail("Choose a Best Buy account.")
  if (!ctx.account.session?.cookie && !ctx.account.session?.accessToken) return pause(SESSION_PAUSE)

  const jar = new CookieJar()
  jar.load(ctx.account.session)
  attachSession(ctx, (cookies) => jar.load(cookies))
  ctx.log("info", "Using the saved Best Buy session.")
  note(ctx, "session", "pass", "Saved Best Buy session loaded.")
  const probe = await probeCart(ctx, jar)
  if (probe.kind === "paused") return { outcome: "paused", reason: probe.reason }
  if (probe.kind === "unauthorized") return pause(EXPIRED_PAUSE)
  if (probe.kind !== "ok") return asResult(probe)

  const pageUrl = monitorUrl(ctx.task.sku, sku)
  ctx.phase("monitoring")
  ctx.log("info", `Watching SKU ${sku} for Best Buy ship-to-home stock at MSRP.`)
  let waits = 0

  while (!ctx.signal.aborted) {
    const stock = await readOffer(ctx, jar, sku, pageUrl)
    if (stock.kind === "paused") return { outcome: "paused", reason: stock.reason }
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
      ctx.detail(reading.title ? `${reading.title} · ${reading.reason}` : reading.reason)
      if (waits === 1 || waits % 10 === 0) ctx.log("info", reading.reason)
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }

    ctx.phase("in_stock")
    ctx.log("success", reading.reason)
    note(ctx, "monitor", "pass", reading.reason)
    if (await holdMonitorOnly(ctx)) continue
    await paceAddToCart(ctx)
    ctx.phase("adding_to_cart")
    const cart = await addToCart(ctx, jar, sku, pageUrl)
    if (cart.kind === "oos") {
      ctx.log("warn", "Add to cart reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (cart.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (cart.kind !== "ok") {
      note(ctx, "cart", "fail", cart.reason)
      return asResult(cart)
    }
    note(ctx, "cart", "pass", "Added the item to the cart.")

    ctx.phase("checking_out")
    const started = await startCheckout(ctx, jar, cart.value)
    if (started.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (started.kind !== "ok") return asResult(started)
    if (!started.value.shippingEligible) return fail("Best Buy is not offering ship-to-home for this item. v1 does not place pickup orders.")
    const shipped = await setShipping(ctx, jar, started.value)
    if (shipped.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (shipped.kind !== "ok") {
      note(ctx, "address", "fail", shipped.reason)
      return asResult(shipped)
    }
    note(ctx, "address", "pass", "Shipping address accepted.")
    note(ctx, "shipping", "pass", "Ship-to-home selected.")
    const lookedUp = await prelookup(ctx, jar, started.value)
    if (lookedUp.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (lookedUp.kind !== "ok") return asResult(lookedUp)
    ctx.log("info", `Submitting payment for the card ending ${ctx.profile.last4}.`)
    const paid = await saveCard(ctx, jar, started.value)
    if (paid.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (paid.kind !== "ok") {
      note(ctx, "payment", "fail", paid.reason)
      return asResult(paid)
    }
    note(ctx, "payment", "pass", "Card encryption accepted. The card was not charged.")
    const refreshed = await refreshPayments(ctx, jar, started.value.orderId)
    if (refreshed.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (refreshed.kind !== "ok") return asResult(refreshed)
    if (ctx.testMode) {
      if (ctx.clearCartAfterTest) note(ctx, "cart", "skip", "Best Buy cart clear is left for you. Test mode does not call a cart-delete API.")
      return finishTest(ctx)
    }
    const order = await placeOrder(ctx, jar, started.value.orderId)
    if (order.kind === "oos") {
      ctx.log("warn", "Checkout reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (order.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (order.kind !== "ok") return asResult(order)
    const orderId = order.value
    return {
      outcome: "success",
      orderId,
      detail: orderId ? `Order ${orderId}` : "Best Buy accepted the shipping order."
    }
  }
  return { outcome: "stopped", reason: "Stopped" }
}

async function readOffer(ctx: StoreRunContext, jar: CookieJar, sku: string, pageUrl: string): Promise<Step<StockReading>> {
  const response = await sharedCall(ctx, monitorKey("bestbuy", sku, "page", ctx.proxy), () => call(ctx, { method: "GET", url: pageUrl, headers: pageHeaders(jar, pageUrl) }))
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (response.status === 429 || response.status >= 500) return { kind: "retry", reason: `Monitor request returned HTTP ${response.status}. Retrying.` }
  const reading = readStock(response.body, sku)
  if (reading) {
    reading.imageUrl = productImage(response.body) || undefined
    noteWatch(ctx, { ...reading, url: pageUrl })
    return { kind: "ok", value: reading }
  }
  if (response.status === 404) return { kind: "ok", value: { inStock: false, status: "NOT_FOUND", sku, reason: "SKU was not found." } }
  return { kind: "retry", reason: `Monitor returned HTTP ${response.status} without a stock reading.` }
}

async function probeCart(ctx: StoreRunContext, jar: CookieJar): Promise<Step<true>> {
  const response = await call(ctx, {
    method: "GET",
    url: "https://www.bestbuy.com/cart/json",
    headers: jsonHeaders(jar, "https://www.bestbuy.com/cart")
  })
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (isGuestCart(response.body)) return { kind: "paused", reason: GUEST_PAUSE }
  if (response.status >= 200 && response.status < 300) return { kind: "ok", value: true }
  ctx.log("warn", `Cart probe returned HTTP ${response.status}. Continuing with the saved session.`)
  return { kind: "ok", value: true }
}

async function addToCart(ctx: StoreRunContext, jar: CookieJar, sku: string, pageUrl: string): Promise<Step<string>> {
  let queueHeaders: Record<string, string> = {}
  for (let attempt = 1; attempt <= QUEUE_ATTEMPTS; attempt += 1) {
    const response = await call(ctx, {
      method: "POST",
      url: "https://www.bestbuy.com/cart/api/v1/addToCart",
      headers: { ...jsonHeaders(jar, pageUrl), ...queueHeaders },
      body: JSON.stringify({ items: [{ skuId: sku, quantity: ctx.task.quantity }] })
    })
    if (isThreeDSecure(response.body) || isChallenge(response.status, response.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
    if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
    const queued = readQueue(response.body)
    const code = header(response, "a2ctransactioncode")
    const reference = header(response, "a2ctransactionreferenceid")
    const waitHeader = header(response, "a2ctransactionwait")
    if (queued || (code && response.status !== 200 && response.status !== 201)) {
      if (attempt === QUEUE_ATTEMPTS) return { kind: "failed", reason: "Best Buy kept the add to cart in the please-wait queue." }
      const seconds = queueSeconds(queued, code, waitHeader, sku)
      if (seconds === null) return { kind: "failed", reason: "Best Buy queued the add to cart, but the wait time could not be read." }
      ctx.log("info", `Best Buy queued the add to cart (please wait). Waiting ${seconds}s then retrying.`)
      await ctx.sleep(seconds * 1000)
      queueHeaders = {}
      if (code) queueHeaders.a2ctransactioncode = code
      if (reference) queueHeaders.a2ctransactionreferenceid = reference
      queueHeaders.a2ctransactionwait = waitHeader || String(seconds)
      continue
    }
    if (outOfStock(response.body)) return { kind: "oos", reason: "Out of stock" }
    if ((response.status === 200 || response.status === 201) && cartAccepted(response.body)) {
      ctx.log("success", `Added ${ctx.task.quantity} to cart.`)
      return { kind: "ok", value: response.body }
    }
    return { kind: "failed", reason: `Add to cart failed (${response.status}): ${snippet(response.body)}` }
  }
  return { kind: "failed", reason: "Best Buy kept the add to cart in the please-wait queue." }
}

function queueSeconds(kind: string | null, code: string, waitHeader: string, sku: string): number | null {
  const numeric = Number(waitHeader)
  const headerSeconds = Number.isFinite(numeric) && numeric >= 0 && numeric <= 900 ? numeric : null
  if (kind === "CONSTRAINED_ITEM_DHV" || kind === "CONSTRAINED_ITEM_PERPETUAL" || kind === "PLEASE_WAIT") return headerSeconds
  if (code) {
    const decoded = decodeQueueSeconds(code, sku)
    if (decoded !== null) return decoded
  }
  return headerSeconds
}

async function startCheckout(ctx: StoreRunContext, jar: CookieJar, cartBody: string): Promise<Step<OrderDetails>> {
  const response = await call(ctx, {
    method: "POST",
    url: "https://www.bestbuy.com/cart/checkout",
    headers: jsonHeaders(jar, "https://www.bestbuy.com/cart"),
    body: JSON.stringify(checkoutPayload(cartBody, ctx.task.sku))
  })
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "failed", reason: `Checkout did not start (${response.status}): ${snippet(response.body)}` }
  }
  const page = await call(ctx, {
    method: "GET",
    url: "https://www.bestbuy.com/checkout/r/fast-track",
    headers: pageHeaders(jar, "https://www.bestbuy.com/cart")
  })
  if (isChallenge(page.status, page.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (isUnauthorized(page.status, page.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  const details = readOrderDetails(page.body)
  if (!details) return { kind: "failed", reason: `Best Buy did not return checkout order data (${page.status}).` }
  if (!details.itemIds.length) return { kind: "failed", reason: "Best Buy did not return a checkout item." }
  return { kind: "ok", value: details }
}

async function setShipping(ctx: StoreRunContext, jar: CookieJar, order: OrderDetails): Promise<Step<true>> {
  const ship = ctx.profile.shipping
  const response = await call(ctx, {
    method: "PATCH",
    url: `https://www.bestbuy.com/checkout/v3/${order.orderId}`,
    headers: {
      ...jsonHeaders(jar, "https://www.bestbuy.com/checkout/r/fulfillment"),
      accept: "application/com.bestbuy.order+json",
      "x-user-interface": "DotCom-Optimized"
    },
    body: JSON.stringify({
      user: {},
      items: order.itemIds.map((id) => ({
        id,
        type: "default",
        fulfillment: {
          type: "shipping",
          address: {
            addressLine1: ship.line1,
            addressLine2: ship.line2,
            city: ship.city,
            state: ship.state,
            postalCode: ship.zip,
            country: "US",
            firstName: ship.firstName,
            lastName: ship.lastName,
            middleInitial: "",
            phoneNumber: ctx.profile.phone,
            type: "shipping",
            classifier: "RESIDENTIAL",
            saveToProfile: false,
            saveAddressAsDefault: false,
            useForBilling: false,
            userOverridden: false
          }
        }
      }))
    })
  })
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "failed", reason: `Shipping was rejected (${response.status}): ${snippet(response.body)}` }
  }
  ctx.log("success", `Shipping address set for ${ship.city}, ${ship.state}.`)
  return { kind: "ok", value: true }
}

async function prelookup(ctx: StoreRunContext, jar: CookieJar, order: OrderDetails): Promise<Step<true>> {
  const response = await call(ctx, {
    method: "POST",
    url: `https://www.bestbuy.com/payment/api/v3/payment/${order.paymentId}/threeDSecure/preLookup`,
    headers: {
      ...jsonHeaders(jar, "https://www.bestbuy.com/checkout/r/payment"),
      "x-client": "CHECKOUT",
      "x-context-id": order.orderId
    },
    body: JSON.stringify({
      binNumber: ctx.profile.card.number.replace(/\D/g, "").slice(0, 6),
      orderId: order.userOrderId || order.orderId,
      paymentId: order.paymentId,
      payComponentVersion: "STANDARD_REDESIGN",
      payVersion: "5.3.276",
      browserInfo: browserInfo()
    })
  })
  if (isThreeDSecure(response.body) || isChallenge(response.status, response.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "failed", reason: `Payment lookup was rejected (${response.status}): ${snippet(response.body)}` }
  }
  return { kind: "ok", value: true }
}

async function saveCard(ctx: StoreRunContext, jar: CookieJar, order: OrderDetails): Promise<Step<true>> {
  const card = ctx.profile.card
  const bill = ctx.profile.billing
  const names = splitName(card.name)
  const keyResponse = await call(ctx, {
    method: "GET",
    url: "https://www.bestbuy.com/api/csiservice/v2/key/tas",
    headers: jsonHeaders(jar, "https://www.bestbuy.com/checkout/r/payment")
  })
  if (isChallenge(keyResponse.status, keyResponse.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (keyResponse.status < 200 || keyResponse.status >= 300) {
    return { kind: "failed", reason: `Best Buy did not return a payment key (HTTP ${keyResponse.status}).` }
  }
  const publicKey = readPublicKey(keyResponse.body)
  if (!publicKey) return { kind: "failed", reason: "Best Buy's payment key response could not be read." }
  let number = ""
  try {
    number = encryptBestBuyPan(card.number, publicKey)
  } catch {
    return { kind: "failed", reason: "Best Buy's payment key could not encrypt the card." }
  }
  const response = await call(
    ctx,
    {
      method: "PUT",
      url: `https://www.bestbuy.com/payment/api/v3/payment/${order.paymentId}/creditCard`,
      headers: {
        ...jsonHeaders(jar, "https://www.bestbuy.com/checkout/r/payment"),
        "x-client": "CHECKOUT",
        "x-context-id": order.orderId
      },
      body: JSON.stringify({
        billingAddress: {
          addressLine1: bill.line1,
          addressLine2: bill.line2,
          city: bill.city,
          country: "US",
          dayPhone: ctx.profile.phone,
          emailAddress: ctx.profile.email,
          firstName: names.first,
          lastName: names.last,
          isSimpleAddress: false,
          postalCode: bill.zip,
          standardized: true,
          state: bill.state,
          userOverridden: false
        },
        creditCard: {
          appliedPoints: "",
          binNumber: card.number.replace(/\D/g, "").slice(0, 6),
          creditCardProfileId: "",
          cvv: card.cvv,
          default: false,
          expMonth: card.expMonth,
          expYear: card.expYear,
          number,
          orderId: order.userOrderId || order.orderId,
          purchaseOrderNumber: "",
          saveToProfile: false,
          type: cardBrand(card.number),
          virtualCard: false
        }
      })
    },
    true
  )
  if (isThreeDSecure(response.body) || isChallenge(response.status, response.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "failed", reason: `Payment was rejected (${response.status}): ${snippet(response.body)}` }
  }
  ctx.log("success", "Payment submitted to Best Buy.")
  return { kind: "ok", value: true }
}

async function refreshPayments(ctx: StoreRunContext, jar: CookieJar, orderId: string): Promise<Step<true>> {
  const response = await call(ctx, {
    method: "POST",
    url: `https://www.bestbuy.com/checkout/v3/${orderId}/paymentMethods/refreshPayments`,
    headers: {
      ...jsonHeaders(jar, "https://www.bestbuy.com/checkout/r/payment"),
      "x-user-interface": "DotCom-Optimized"
    },
    body: "{}"
  })
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (response.status < 200 || response.status >= 300) {
    return { kind: "failed", reason: `Payment refresh was rejected (${response.status}): ${snippet(response.body)}` }
  }
  return { kind: "ok", value: true }
}

async function placeOrder(ctx: StoreRunContext, jar: CookieJar, orderId: string): Promise<Step<string | undefined>> {
  const response = await call(ctx, {
    method: "POST",
    url: `https://www.bestbuy.com/checkout/v3/${orderId}`,
    headers: {
      ...jsonHeaders(jar, "https://www.bestbuy.com/checkout/r/payment"),
      "x-user-interface": "DotCom-Optimized"
    },
    body: JSON.stringify({
      user: {},
      metadata: {
        userDeviceDetails: { forterToken: `${randomBytes(16).toString("hex")}_${Date.now()}` },
        browserInfo: browserInfo(),
        buyLegalMessaging: []
      }
    })
  })
  if (isThreeDSecure(response.body) || isChallenge(response.status, response.body)) return { kind: "paused", reason: BESTBUY_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (outOfStock(response.body)) return { kind: "oos", reason: "Out of stock" }
  if (bodyHas(response.body, "PAYMENT_DECLINED") || bodyHas(response.body, "declined")) {
    return { kind: "failed", reason: "Best Buy declined the card." }
  }
  const order = safeJson(response.body)
  const record = asRecord(order)
  const userOrderId = typeof record?.userOrderId === "string" ? record.userOrderId : undefined
  const status = typeof record?.status === "string" ? record.status : ""
  if (response.status >= 200 && response.status < 300 && status.toLowerCase() === "submitted") {
    return { kind: "ok", value: userOrderId }
  }
  return { kind: "failed", reason: `Checkout failed (${response.status}): ${snippet(response.body)}` }
}

function checkoutPayload(cartBody: string, skuInput: string): Record<string, unknown> {
  const json = asRecord(safeJson(cartBody)) ?? {}
  const subTotal = typeof json.cartSubTotal === "number" ? json.cartSubTotal : 0
  const items = Array.isArray(json.summaryItems) ? json.summaryItems : []
  const cartItems = items.map((item) => {
    const record = asRecord(item) ?? {}
    const price = asRecord(record.priceDetails)
    const amount = typeof price?.totalCustomerPrice === "number" ? price.totalCustomerPrice : subTotal
    return {
      sku: typeof record.skuId === "string" ? record.skuId : parseSku(skuInput) ?? "",
      totalCustomerPrice: `$${amount.toFixed(2)}`,
      isDigital: false
    }
  })
  if (!cartItems.length) {
    cartItems.push({ sku: parseSku(skuInput) ?? "", totalCustomerPrice: `$${subTotal.toFixed(2)}`, isDigital: false })
  }
  return {
    productTotal: subTotal.toFixed(2).replace(".", ","),
    subTotal,
    hasSubscription: false,
    isAccountCreationRequired: false,
    isReadyForCheckoutWithDefaults: false,
    cartItems
  }
}

async function call(ctx: StoreRunContext, request: HttpRequest, carriesCard = false): Promise<HttpResponse> {
  const host = new URL(request.url).hostname
  if (carriesCard && host !== HOST) throw new Error("Card data can only be sent to the retailer.")
  if (host !== HOST) throw new Error(`Refusing to contact ${host}.`)
  return ctx.http.request({ ...request, proxy: ctx.proxy, signal: ctx.signal })
}

function pageHeaders(jar: CookieJar, referer: string): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": chromeUserAgent(),
    referer,
    cookie: jar.header()
  }
}

function jsonHeaders(jar: CookieJar, referer: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.bestbuy.com",
    referer,
    "user-agent": chromeUserAgent(),
    cookie: jar.header()
  }
}

function browserInfo(): Record<string, unknown> {
  return {
    javaEnabled: false,
    language: "en-US",
    userAgent: chromeUserAgent(),
    height: "1440",
    width: "2560",
    timeZone: "240",
    colorDepth: "24"
  }
}

function header(response: HttpResponse, name: string): string {
  const value = response.headers[name] ?? response.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

function cartAccepted(body: string): boolean {
  const json = asRecord(safeJson(body))
  if (!json || readQueue(body)) return false
  return typeof json.cartCount === "number" || typeof json.cartSubTotal === "number" || Array.isArray(json.summaryItems) || json.cartItemCount !== undefined
}

function outOfStock(body: string): boolean {
  const text = body.toLowerCase()
  if (readQueue(body)) return false
  return text.includes("item_not_sellable") || text.includes("out_of_stock") || text.includes("not available")
}

function readPublicKey(body: string): string | undefined {
  const json = asRecord(safeJson(body))
  const key = json?.publicKey
  return typeof key === "string" && key.trim() ? key : undefined
}

function cardBrand(number: string): string {
  if (number.startsWith("4")) return "VISA"
  if (number.startsWith("5")) return "MASTERCARD"
  if (number.startsWith("3")) return "AMEX"
  if (number.startsWith("6")) return "DISCOVER"
  return "VISA"
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/)
  return { first: parts[0] || "Customer", last: parts.slice(1).join(" ") || parts[0] || "Customer" }
}

function bodyHas(body: string, marker: string): boolean {
  return body.toLowerCase().includes(marker.toLowerCase())
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
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
  return { outcome: "failed", reason: step.reason }
}
