import { randomBytes } from "node:crypto"
import { attachSession } from "../../engine/block-recovery"
import { holdMonitorOnly, monitorKey, monitorPlaces, noteWatch, sharedCall } from "../../engine/monitor"
import { productImage } from "../../shared/image"
import { finishTest, note } from "../../engine/test-mode"
import { redact } from "../../shared/redact"
import type { SessionCookies } from "../../shared/types"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import type { StoreModule, StoreRunContext, StoreRunResult } from "../module"
import {
  bodyHas,
  findCartId,
  findCartItemId,
  findOrderId,
  isChallenge,
  isUnauthorized,
  parseStock,
  paymentInstructionId,
  stockProblem,
  type StockReading
} from "./parse"
import { parseTcin } from "../../shared/tcin"

const DEFAULT_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96"
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const ALLOWED_HOSTS = new Set(["carts.target.com", "redsky.target.com", "gsp.target.com", "www.target.com"])
const FIELD_GROUPS = "ADDRESSES,CART,CART_ITEMS,SUMMARY,PAYMENT_INSTRUCTIONS,PROMOTION_CODES"

export const TARGET_PAUSE =
  "Target presented a challenge or block. Sign in with your own browser, paste accessToken, visitorId, and refreshToken on the account, then resume. TCGAIO does not send challenges to a solving service."

class CookieJar {
  accessToken = ""
  refreshToken = ""
  visitorId = ""
  idToken = ""

  load(session?: SessionCookies): void {
    this.accessToken = session?.accessToken ?? ""
    this.refreshToken = session?.refreshToken ?? ""
    this.visitorId = session?.visitorId ?? ""
    this.idToken = session?.idToken ?? ""
  }

  header(): string {
    const parts: string[] = []
    if (this.accessToken) parts.push(`accessToken=${this.accessToken}`)
    if (this.visitorId) {
      parts.push(`visitorId=${this.visitorId}`)
      parts.push(`visitorID=${this.visitorId}`)
    }
    if (this.refreshToken) parts.push(`refreshToken=${this.refreshToken}`)
    if (this.idToken) parts.push(`idToken=${this.idToken}`)
    return parts.join("; ")
  }

  toSession(): SessionCookies {
    return {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken || undefined,
      visitorId: this.visitorId || undefined,
      idToken: this.idToken || undefined
    }
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

export function createTargetModule(): StoreModule {
  return {
    id: "target",
    displayName: "Target",
    skuHint: "TCIN or product URL",
    implemented: true,
    run: (ctx) => runTarget(ctx)
  }
}

async function runTarget(ctx: StoreRunContext): Promise<StoreRunResult> {
  const tcin = parseTcin(ctx.task.sku)
  if (!tcin) return fail("Enter a Target TCIN or a product URL that contains /A-########.")
  if (ctx.profile.shipping.country !== "US") return fail("v1 places US ship-to-home orders only.")
  if (ctx.account.store !== "target") return fail("Choose a Target account.")

  const key = ctx.settings.targetApiKey.trim() || DEFAULT_KEY
  const location = {
    storeId: ctx.settings.targetStoreId.trim() || "1881",
    zip: ctx.settings.targetZip.trim() || "10001",
    state: ctx.settings.targetState.trim().toUpperCase() || "NY"
  }
  const jar = new CookieJar()
  attachSession(ctx, (cookies) => jar.load(cookies))
  const sessionResult = await ensureSession(ctx, jar, key)
  if (sessionResult) {
    note(ctx, "session", "fail", "reason" in sessionResult ? sessionResult.reason : "Session check failed.")
    return sessionResult
  }
  note(ctx, "session", "pass", "Session is ready.")

  ctx.phase("monitoring")
  ctx.log("info", `Watching TCIN ${tcin} for ship-to-home stock (store ${location.storeId}, ZIP ${location.zip}).`)
  let oosPolls = 0

  while (!ctx.signal.aborted) {
    const stock = await readStockPlaces(ctx, key, tcin)
    if (stock.kind === "paused") return { outcome: "paused", reason: stock.reason }
    if (stock.kind === "retry") {
      ctx.detail(stock.reason)
      ctx.log("warn", stock.reason)
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (stock.kind !== "ok") return asResult(stock)
    const reading = stock.value
    if (reading.title) ctx.detail(reading.title)
    if (!reading.inStock) {
      oosPolls += 1
      const message = `Out of stock for shipping (${reading.status}).`
      ctx.detail(reading.title ? `${reading.title} · ${message}` : message)
      if (oosPolls === 1 || oosPolls % 10 === 0) ctx.log("info", message)
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }

    ctx.phase("in_stock")
    ctx.log("success", `Shipping in stock (${reading.status})${reading.title ? ` · ${reading.title}` : ""}.`)
    note(ctx, "monitor", "pass", `In stock (${reading.status}).`)
    if (await holdMonitorOnly(ctx)) continue
    ctx.phase("adding_to_cart")
    const cart = await addToCart(ctx, jar, key, tcin)
    if (cart.kind === "oos") {
      ctx.log("warn", "Add to cart reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (cart.kind === "unauthorized") {
      const recovered = await recoverAuth(ctx, jar, key)
      if (recovered !== true) return recovered
      continue
    }
    if (cart.kind !== "ok") {
      note(ctx, "cart", "fail", cart.reason)
      return asResult(cart)
    }
    note(ctx, "cart", "pass", `Added ${ctx.task.quantity} to the cart.`)

    ctx.phase("checking_out")
    ctx.log("info", "Submitting the shipping address from the saved profile.")
    const shipped = await submitShipping(ctx, jar, key)
    if (shipped.kind !== "ok") {
      note(ctx, "address", "fail", shipped.reason)
      return asResult(shipped)
    }
    note(ctx, "address", "pass", "Shipping address accepted.")
    note(ctx, "shipping", "pass", "Ship-to-home selected.")
    ctx.log("info", `Submitting payment for the card ending ${ctx.profile.last4}.`)
    const paid = await submitPayment(ctx, jar, key, cart.value.cartId)
    if (paid.kind !== "ok") {
      note(ctx, "payment", "fail", paid.reason)
      return asResult(paid)
    }
    note(ctx, "payment", "pass", "Payment instruction accepted. The card was not charged.")
    if (ctx.testMode) {
      if (ctx.clearCartAfterTest && cart.value.itemId) {
        const cleared = await clearTargetLine(ctx, jar, key, tcin, cart.value.itemId)
        note(ctx, "cart", cleared ? "pass" : "fail", cleared ? "Removed the test line from the cart." : "The test line could not be removed.")
      } else if (ctx.clearCartAfterTest) {
        note(ctx, "cart", "skip", "Target did not return a cart line id, so the cart was left as-is.")
      }
      return finishTest(ctx)
    }
    const order = await placeOrder(ctx, jar, key, cart.value.cartId)
    if (order.kind === "oos") {
      ctx.log("warn", "Checkout returned an empty cart. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (order.kind !== "ok") return asResult(order)
    const orderId = order.value
    return {
      outcome: "success",
      orderId,
      detail: orderId ? `Order ${orderId}` : "Target accepted the shipping order."
    }
  }
  return { outcome: "stopped", reason: "Stopped" }
}

async function ensureSession(ctx: StoreRunContext, jar: CookieJar, key: string): Promise<StoreRunResult | null> {
  if (ctx.account.session?.accessToken) {
    jar.load(ctx.account.session)
    ctx.log("info", "Using the saved Target session.")
  } else if (ctx.account.password) {
    ctx.log("info", "Signing in to Target with the saved account.")
    const loggedIn = await login(ctx, jar)
    if (loggedIn.kind !== "ok") return asResult(loggedIn)
    await ctx.onSession(jar.toSession())
    ctx.log("success", "Signed in.")
  } else {
    return fail("Add a Target password or paste a browser session on the account.")
  }
  if (!jar.visitorId) jar.visitorId = randomBytes(16).toString("hex")
  const probe = await probeCart(ctx, jar, key)
  if (probe.kind === "ok") return null
  if (probe.kind === "unauthorized") {
    const recovered = await recoverAuth(ctx, jar, key)
    return recovered === true ? null : recovered
  }
  return asResult(probe)
}

async function recoverAuth(ctx: StoreRunContext, jar: CookieJar, key: string): Promise<true | StoreRunResult> {
  if (jar.refreshToken) {
    ctx.log("info", "Refreshing the Target session.")
    const refreshed = await refresh(ctx, jar)
    if (refreshed.kind === "paused") return { outcome: "paused", reason: refreshed.reason }
    if (refreshed.kind !== "ok") ctx.log("warn", refreshed.reason)
    if (refreshed.kind === "ok") {
      await ctx.onSession(jar.toSession())
      const probe = await probeCart(ctx, jar, key)
      if (probe.kind === "ok") {
        ctx.log("success", "Session refreshed.")
        return true
      }
      if (probe.kind === "paused") return { outcome: "paused", reason: probe.reason }
    }
  }
  if (!ctx.account.password) {
    return pause("The Target session expired. Paste a fresh browser session, then resume.")
  }
  ctx.log("info", "Session refresh failed. Signing in again.")
  const loggedIn = await login(ctx, jar)
  if (loggedIn.kind !== "ok") return asResult(loggedIn)
  await ctx.onSession(jar.toSession())
  ctx.log("success", "Signed in.")
  return true
}

async function readStockPlaces(ctx: StoreRunContext, key: string, tcin: string): Promise<Step<StockReading>> {
  const places = monitorPlaces(ctx.settings)
  let last: Step<StockReading> | undefined
  for (const place of places) {
    const stock = await readStock(ctx, key, tcin, { ...place, state: ctx.settings.targetState.trim().toUpperCase() || "NY" })
    if (stock.kind === "paused" || stock.kind === "retry") return stock
    if (stock.kind !== "ok") return stock
    last = stock
    if (stock.value.inStock) break
  }
  if (last?.kind === "ok") noteWatch(ctx, { ...last.value, url: `https://www.target.com/p/-/A-${tcin}` })
  return last ?? { kind: "retry", reason: "No monitor location is configured." }
}

async function readStock(
  ctx: StoreRunContext,
  key: string,
  tcin: string,
  location: { storeId: string; zip: string; state: string }
): Promise<Step<StockReading>> {
  const summary = new URL("https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1")
  summary.searchParams.set("key", key)
  summary.searchParams.set("tcins", tcin)
  summary.searchParams.set("store_id", location.storeId)
  summary.searchParams.set("pricing_store_id", location.storeId)
  summary.searchParams.set("zip", location.zip)
  summary.searchParams.set("state", location.state)
  summary.searchParams.set("channel", "WEB")
  summary.searchParams.set("page", `/p/A-${tcin}`)
  const primary = await sharedCall(ctx, monitorKey("target", tcin, `${location.zip}:${location.storeId}`, ctx.proxy), () => call(ctx, { method: "GET", url: summary.toString(), headers: monitorHeaders(tcin) }))
  const primaryStep = interpretMonitor(primary)
  if (primaryStep.kind === "paused") return primaryStep
  if (primaryStep.kind === "ok" && primaryStep.value.status !== "UNKNOWN" && primaryStep.value.status !== "NOT_FOUND") {
    return primaryStep
  }
  const legacy = new URL("https://redsky.target.com/redsky_aggregations/v1/web/pdp_fulfillment_v1")
  legacy.searchParams.set("key", key)
  legacy.searchParams.set("tcin", tcin)
  legacy.searchParams.set("store_id", location.storeId)
  legacy.searchParams.set("pricing_store_id", location.storeId)
  legacy.searchParams.set("zip", location.zip)
  legacy.searchParams.set("state", location.state)
  legacy.searchParams.set("channel", "WEB")
  const secondary = await call(ctx, { method: "GET", url: legacy.toString(), headers: monitorHeaders(tcin) })
  const secondaryStep = interpretMonitor(secondary)
  if (secondaryStep.kind === "ok" || secondaryStep.kind === "paused") return secondaryStep
  if (primaryStep.kind === "ok") return primaryStep
  return secondaryStep
}

function interpretMonitor(response: HttpResponse): Step<StockReading> {
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: TARGET_PAUSE }
  if (response.status === 429 || response.status >= 500) {
    return { kind: "retry", reason: `Monitor request returned HTTP ${response.status}. Retrying.` }
  }
  const reading = parseStock(response.body)
  if (reading) reading.imageUrl = productImage(response.body) || undefined
  const problem = stockProblem(response.body)
  if (problem && (!reading || reading.status === "UNKNOWN" || reading.status === "NOT_FOUND")) {
    return { kind: "retry", reason: problem }
  }
  if (!reading || (response.status >= 400 && reading.status === "NOT_FOUND")) {
    return { kind: "retry", reason: `Monitor returned HTTP ${response.status} without a stock reading.` }
  }
  return { kind: "ok", value: reading }
}

async function probeCart(ctx: StoreRunContext, jar: CookieJar, key: string): Promise<Step<true>> {
  const url = `https://carts.target.com/web_checkouts/v1/cart?field_groups=CART,SUMMARY&key=${encodeURIComponent(key)}`
  const response = await call(ctx, { method: "GET", url, headers: apiHeaders(jar, "https://www.target.com/cart") })
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: TARGET_PAUSE }
  if (isUnauthorized(response.status, response.body)) {
    ctx.log("warn", `Cart session check returned HTTP ${response.status}.`)
    return { kind: "unauthorized", reason: "Unauthorized" }
  }
  if (response.status >= 200 && response.status < 300) return { kind: "ok", value: true }
  if (response.status === 404 || response.status === 400) return { kind: "ok", value: true }
  ctx.log("warn", `Cart probe returned HTTP ${response.status}. Continuing with the saved session.`)
  return { kind: "ok", value: true }
}

async function addToCart(ctx: StoreRunContext, jar: CookieJar, key: string, tcin: string): Promise<Step<{ cartId: string; itemId?: string }>> {
  const url = `https://carts.target.com/web_checkouts/v1/cart_items?field_groups=CART,CART_ITEMS,SUMMARY&key=${encodeURIComponent(key)}`
  const response = await call(ctx, {
    method: "POST",
    url,
    headers: apiHeaders(jar, `https://www.target.com/p/-/A-${tcin}`),
    body: JSON.stringify({
      cart_type: "REGULAR",
      channel_id: "10",
      shopping_context: "DIGITAL",
      cart_item: { tcin, quantity: ctx.task.quantity, item_channel_id: "10" }
    })
  })
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: TARGET_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (bodyHas(response.body, "MAX_PURCHASE_LIMIT_EXCEEDED")) {
    return { kind: "failed", reason: "Target rejected the quantity because it is over the purchase limit." }
  }
  if (bodyHas(response.body, "DEPENDENT_SERVICE_ERROR") || bodyHas(response.body, "ITEM_NOT_AVAILABLE")) {
    return { kind: "oos", reason: "Out of stock" }
  }
  const cartId = findCartId(response.body)
  if ((response.status === 200 || response.status === 201) && cartId) {
    ctx.log("success", `Added ${ctx.task.quantity} to cart.`)
    const itemId = findCartItemId(response.body)
    if (itemId) await setShipFulfillment(ctx, jar, key, tcin, itemId)
    return { kind: "ok", value: { cartId, itemId } }
  }
  return { kind: "failed", reason: `Add to cart failed (${response.status}): ${snippet(response.body)}` }
}

async function setShipFulfillment(ctx: StoreRunContext, jar: CookieJar, key: string, tcin: string, itemId: string): Promise<void> {
  const url = `https://carts.target.com/web_checkouts/v1/cart_items/${encodeURIComponent(itemId)}?field_groups=CART,CART_ITEMS,SUMMARY&key=${encodeURIComponent(key)}`
  const response = await call(ctx, {
    method: "PUT",
    url,
    headers: apiHeaders(jar, `https://www.target.com/p/-/A-${tcin}`),
    body: JSON.stringify({
      cart_type: "REGULAR",
      channel_id: "10",
      cart_item: {
        tcin,
        quantity: ctx.task.quantity,
        fulfillment: { type: "SHIP", ship_method: "STANDARD" }
      }
    })
  })
  if (response.status >= 200 && response.status < 300) ctx.log("info", "Set fulfillment to standard shipping.")
  else ctx.log("warn", `Shipping fulfillment update returned HTTP ${response.status}. Continuing with the shipping address.`)
}

async function submitShipping(ctx: StoreRunContext, jar: CookieJar, key: string): Promise<Step<true>> {
  const ship = ctx.profile.shipping
  const url = `https://carts.target.com/web_checkouts/v1/cart_shipping_addresses?field_groups=${encodeURIComponent(FIELD_GROUPS)}&key=${encodeURIComponent(key)}`
  const response = await call(ctx, {
    method: "POST",
    url,
    headers: apiHeaders(jar, "https://www.target.com/checkout"),
    body: JSON.stringify({
      cart_type: "REGULAR",
      selected: true,
      save_to_profile: false,
      skip_verification: true,
      address: {
        address_line1: ship.line1,
        address_line2: ship.line2,
        address_type: "SHIPPING",
        city: ship.city,
        country: "US",
        first_name: ship.firstName,
        last_name: ship.lastName,
        mobile: ctx.profile.phone,
        save_as_default: false,
        state: ship.state,
        zip_code: ship.zip
      }
    })
  })
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: TARGET_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "paused", reason: "Target rejected the session while saving the shipping address." }
  if (bodyHas(response.body, "NOT_SOLD_FOR_SHIP") || bodyHas(response.body, "SHIPPING_RESTRICTED")) {
    return { kind: "failed", reason: "Target is not offering ship-to-home for this item. v1 does not place pickup orders." }
  }
  if ((response.status >= 200 && response.status < 300) || bodyHas(response.body, "ADDRESS_ALREADY_PRESENT")) {
    ctx.log("success", `Shipping address set for ${ship.city}, ${ship.state}.`)
    return { kind: "ok", value: true }
  }
  if (bodyHas(response.body, "address.mobile")) return { kind: "failed", reason: "Target requires a phone number on the shipping profile." }
  return { kind: "failed", reason: `Shipping address was rejected (${response.status}): ${snippet(response.body)}` }
}

async function submitPayment(ctx: StoreRunContext, jar: CookieJar, key: string, cartId: string): Promise<Step<true>> {
  const card = ctx.profile.card
  const bill = ctx.profile.billing
  const url = `https://carts.target.com/checkout_payments/v1/payment_instructions?key=${encodeURIComponent(key)}`
  const response = await call(
    ctx,
    {
      method: "POST",
      url,
      headers: apiHeaders(jar, "https://www.target.com/checkout"),
      body: JSON.stringify({
        cart_id: cartId,
        wallet_mode: "NONE",
        payment_type: "CARD",
        card_details: {
          card_name: card.name,
          card_number: card.number,
          cvv: card.cvv,
          expiry_month: card.expMonth,
          expiry_year: card.expYear
        },
        billing_address: {
          address_line1: bill.line1,
          city: bill.city,
          first_name: bill.firstName,
          last_name: bill.lastName,
          phone: ctx.profile.phone,
          state: bill.state,
          zip_code: bill.zip,
          country: "US"
        }
      })
    },
    true
  )
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: TARGET_PAUSE }
  if ((response.status >= 200 && response.status < 300) || bodyHas(response.body, "CARD_PAYMENT_EXIST") || bodyHas(response.body, "INVALID_PAYMENT_COMBINATION")) {
    ctx.log("success", "Payment instruction accepted.")
    return { kind: "ok", value: true }
  }
  return { kind: "failed", reason: `Payment was rejected (${response.status}): ${snippet(response.body)}` }
}

async function placeOrder(ctx: StoreRunContext, jar: CookieJar, key: string, cartId: string): Promise<Step<string | undefined>> {
  let response = await checkout(ctx, jar, key)
  if (bodyHas(response.body, "MISSING_CREDIT_CARD_CVV") || bodyHas(response.body, "Missing CVV")) {
    const instruction = paymentInstructionId(response.body)
    if (!instruction) return { kind: "failed", reason: "Target asked for the CVV again but did not return a payment instruction id." }
    ctx.log("info", "Target asked for the CVV again. Resubmitting it.")
    const cvv = await call(
      ctx,
      {
        method: "PUT",
        url: `https://carts.target.com/checkout_payments/v1/payment_instructions/${encodeURIComponent(instruction)}?key=${encodeURIComponent(key)}`,
        headers: apiHeaders(jar, "https://www.target.com/checkout"),
        body: JSON.stringify({
          cart_id: cartId,
          wallet_mode: "NONE",
          payment_type: "CARD",
          card_details: { cvv: ctx.profile.card.cvv }
        })
      },
      true
    )
    if (isChallenge(cvv.status, cvv.body)) return { kind: "paused", reason: TARGET_PAUSE }
    if (cvv.status < 200 || cvv.status >= 300) return { kind: "failed", reason: `CVV resubmit failed (${cvv.status}).` }
    response = await checkout(ctx, jar, key)
  }
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: TARGET_PAUSE }
  if (bodyHas(response.body, "PAYMENT_DECLINED")) return { kind: "failed", reason: "Target declined the card." }
  if (bodyHas(response.body, "EMPTY_CART_FOR_ORDER_SUBMIT") || bodyHas(response.body, "CART_TOTAL_AMOUNT_ZERO")) {
    return { kind: "oos", reason: "Empty cart" }
  }
  const orderId = findOrderId(response.body)
  if (orderId || (response.status >= 200 && response.status < 300 && bodyHas(response.body, "orders"))) {
    return { kind: "ok", value: orderId }
  }
  return { kind: "failed", reason: `Checkout failed (${response.status}): ${snippet(response.body)}` }
}

async function clearTargetLine(ctx: StoreRunContext, jar: CookieJar, key: string, tcin: string, itemId: string): Promise<boolean> {
  const url = `https://carts.target.com/web_checkouts/v1/cart_items/${encodeURIComponent(itemId)}?field_groups=CART&key=${encodeURIComponent(key)}`
  const response = await call(ctx, {
    method: "PUT",
    url,
    headers: apiHeaders(jar, "https://www.target.com/cart"),
    body: JSON.stringify({ cart_type: "REGULAR", channel_id: "10", cart_item: { tcin, quantity: 0 } })
  })
  return response.status >= 200 && response.status < 300
}

function checkout(ctx: StoreRunContext, jar: CookieJar, key: string): Promise<HttpResponse> {
  const url = `https://carts.target.com/web_checkouts/v1/checkout?field_groups=${encodeURIComponent(FIELD_GROUPS)}&key=${encodeURIComponent(key)}`
  return call(ctx, {
    method: "POST",
    url,
    headers: apiHeaders(jar, "https://www.target.com/checkout"),
    body: JSON.stringify({ cart_type: "REGULAR", channel_id: 10 })
  })
}

async function login(ctx: StoreRunContext, jar: CookieJar): Promise<Step<true>> {
  if (!jar.visitorId) jar.visitorId = randomBytes(16).toString("hex")
  const device = { visitor_id: jar.visitorId, user_agent: USER_AGENT, language: "en-US" }
  const response = await call(ctx, {
    method: "POST",
    url: "https://gsp.target.com/gsp/authentications/v1/credential_validations?client_id=ecom-web-1.0.0",
    headers: apiHeaders(jar, "https://www.target.com/account", true),
    body: JSON.stringify({
      username: ctx.account.username,
      password: ctx.account.password,
      keep_me_signed_in: true,
      device_info: device
    })
  })
  absorbCookies(jar, response)
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: TARGET_PAUSE }
  if (bodyHas(response.body, "_ERR_USER_DOES_NOT_EXIST")) return { kind: "failed", reason: "Target could not find that account." }
  if (bodyHas(response.body, "_ERR_AUTH_DENIED") || response.status === 401) {
    return { kind: "failed", reason: "Target rejected the password." }
  }
  if (response.status !== 200 && response.status !== 202) {
    return { kind: "failed", reason: `Sign-in failed (${response.status}): ${snippet(response.body)}` }
  }
  const codeResponse = await call(ctx, {
    method: "GET",
    url: "https://gsp.target.com/gsp/authentications/v1/auth_codes?client_id=ecom-web-1.0.0",
    headers: apiHeaders(jar, "https://www.target.com/account", false),
    redirect: "manual"
  })
  absorbCookies(jar, codeResponse)
  if (isChallenge(codeResponse.status, codeResponse.body)) return { kind: "paused", reason: TARGET_PAUSE }
  const location = headerString(codeResponse, "location")
  const code = location.match(/[?&]code=([^&]+)/)?.[1]
  if (!code) return { kind: "failed", reason: "Target did not return a sign-in code. Paste a browser session instead." }
  const tokenResponse = await call(ctx, {
    method: "POST",
    url: "https://gsp.target.com/gsp/oauth_tokens/v2/client_tokens",
    headers: apiHeaders(jar, "https://www.target.com/account"),
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_credential: { client_id: "ecom-web-1.0.0" },
      code: decodeURIComponent(code),
      device_info: device
    })
  })
  return applyTokenResponse(jar, tokenResponse)
}

async function refresh(ctx: StoreRunContext, jar: CookieJar): Promise<Step<true>> {
  const response = await call(ctx, {
    method: "POST",
    url: "https://gsp.target.com/gsp/oauth_tokens/v2/client_tokens",
    headers: apiHeaders(jar, "https://www.target.com/account"),
    body: JSON.stringify({ grant_type: "refresh_token", client_credential: { client_id: "ecom-web-1.0.0" } })
  })
  return applyTokenResponse(jar, response)
}

function applyTokenResponse(jar: CookieJar, response: HttpResponse): Step<true> {
  absorbCookies(jar, response)
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: TARGET_PAUSE }
  const json = safeParse(response.body)
  if (typeof json?.access_token === "string") jar.accessToken = json.access_token
  if (typeof json?.refresh_token === "string") jar.refreshToken = json.refresh_token
  if (typeof json?.id_token === "string") jar.idToken = json.id_token
  if (!jar.accessToken || response.status >= 400) {
    return { kind: "failed", reason: `Target did not return a session token (${response.status}).` }
  }
  return { kind: "ok", value: true }
}

function absorbCookies(jar: CookieJar, response: HttpResponse): void {
  const raw = response.headers["set-cookie"]
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : []
  for (const cookie of cookies) {
    const pair = cookie.split(";")[0] ?? ""
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name === "accessToken") jar.accessToken = value
    if (name === "refreshToken") jar.refreshToken = value
    if (name === "visitorId" || name === "visitorID") jar.visitorId = value
    if (name === "idToken") jar.idToken = value
  }
}

async function call(ctx: StoreRunContext, request: HttpRequest, carriesCard = false): Promise<HttpResponse> {
  const host = new URL(request.url).hostname
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`Refusing to contact ${host}.`)
  if (carriesCard && host !== "carts.target.com") throw new Error("Card data can only be sent to the retailer.")
  return ctx.http.request({ ...request, proxy: ctx.proxy, signal: ctx.signal })
}

function monitorHeaders(tcin: string): Record<string, string> {
  return {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.target.com",
    referer: `https://www.target.com/p/-/A-${tcin}`,
    "user-agent": USER_AGENT
  }
}

function apiHeaders(jar: CookieJar, referer: string, json = true): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.target.com",
    referer,
    "user-agent": USER_AGENT,
    "x-application-name": "web"
  }
  if (json) headers["content-type"] = "application/json"
  const cookie = jar.header()
  if (cookie) headers.cookie = cookie
  if (jar.accessToken) headers.authorization = `Bearer ${jar.accessToken}`
  return headers
}

function headerString(response: HttpResponse, name: string): string {
  const value = response.headers[name] ?? response.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] ?? "" : value ?? ""
}

function snippet(body: string): string {
  return redact(body).replace(/\s+/g, " ").slice(0, 240)
}

function safeParse(body: string): Record<string, unknown> | undefined {
  try {
    const json = JSON.parse(body) as unknown
    if (!json || typeof json !== "object" || Array.isArray(json)) return undefined
    return json as Record<string, unknown>
  } catch {
    return undefined
  }
}

function fail(reason: string): StoreRunResult {
  return { outcome: "failed", reason }
}

function pause(reason: string): StoreRunResult {
  return { outcome: "paused", reason }
}

function asResult(step: StepStop): StoreRunResult {
  if (step.kind === "paused") return { outcome: "paused", reason: step.reason }
  if (step.kind === "unauthorized" || step.kind === "oos") return { outcome: "failed", reason: step.reason }
  return { outcome: "failed", reason: step.reason }
}
