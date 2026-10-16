import { randomBytes } from "node:crypto"
import { redact } from "../../shared/redact"
import type { SessionCookies } from "../../shared/types"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import type { StoreModule, StoreRunContext, StoreRunResult } from "../module"
import {
  bodyHas,
  findAddressId,
  findCartId,
  findContractId,
  findOrderId,
  findPaymentId,
  graphqlMessage,
  isChallenge,
  isUnauthorized,
  parseItemId,
  readStock,
  type StockReading
} from "./parse"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const ALLOWED_HOSTS = new Set(["www.walmart.com"])
const OFFERS_HASH = "a7ea759bd71585427be5fffd34326a399c017f162cae893fc3e8c9d00cdcb34c"
const CART_HASH = "f9e23365bcbea20fa5894ef17dd63c0cc3da2e3e8f96798320cc7d6752f95941"
const UPDATE_ITEMS_HASH = "5bdd18fcb51caa2ae775b1ccfbdcd1f5df0d13d52ef949724a3912591e2b02f8"
const FULFILLMENT_HASH = "2bcd58a69bb70e776f0c6cb6d34efdcc9460ed2ce0a8d414bbbd9e7a0a176567"
const SET_SHIPPING_HASH = "8cd71316569daf4a50f3068be99c2f3d2b4637677fff6f426fe55b4b99a6695e"
const ADDRESS_HASH = "d71fd5997833c8d7b6440382343cbd87517c5b7cdee5f2bca458277dd3e23e5a"
const CARD_HASH = "e75129334cbed049947ccff1c11fc4b42c4bbcbbdf17d3139fd59054118d18ff"
const BUY_NOW_HASH = "06b9e81cc3226546598a05bd9c72341f924b85136489f589c25a603420723fbd"
const PLACE_ORDER_HASH = "adcc04b8125ca24a076fe09d4a9580834bb9a04df022a36bbb4658f76bc888ac"

export const WALMART_PAUSE =
  "Walmart presented a PerimeterX or press-and-hold challenge. Sign in with your own browser, paste the auth and CID cookies on the account, then resume. TCGAIO does not solve challenges."

const SESSION_PAUSE = "Paste a Walmart browser session (auth and CID cookies) on the account. Password sign-in is blocked by PerimeterX, and TCGAIO does not solve challenges."
const EXPIRED_PAUSE = "The Walmart session expired. Paste a fresh auth and CID cookie, then resume."

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
    if (this.accessToken) parts.push(`auth=${this.accessToken}`)
    if (this.visitorId) parts.push(`CID=${this.visitorId}`)
    return parts.join("; ")
  }

  toSession(): SessionCookies {
    return {
      accessToken: this.accessToken,
      visitorId: this.visitorId || undefined,
      cookie: this.raw || undefined
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

export function createWalmartModule(): StoreModule {
  return {
    id: "walmart",
    displayName: "Walmart",
    skuHint: "Item ID or product URL",
    implemented: true,
    run: (ctx) => runWalmart(ctx)
  }
}

async function runWalmart(ctx: StoreRunContext): Promise<StoreRunResult> {
  const itemId = parseItemId(ctx.task.sku)
  if (!itemId) return fail("Enter a Walmart item ID or a product URL that contains /ip/.")
  if (ctx.profile.shipping.country !== "US") return fail("v1 places US ship-to-home orders only.")
  if (ctx.account.store !== "walmart") return fail("Choose a Walmart account.")
  if (!ctx.account.session?.accessToken) return pause(SESSION_PAUSE)

  const jar = new CookieJar()
  jar.load(ctx.account.session)
  ctx.log("info", "Using the saved Walmart session.")
  const probe = await probeCart(ctx, jar)
  if (probe.kind === "paused") return { outcome: "paused", reason: probe.reason }
  if (probe.kind === "unauthorized") return pause(EXPIRED_PAUSE)

  ctx.phase("monitoring")
  ctx.log("info", `Watching item ${itemId} for Walmart.com ship-to-home stock at MSRP.`)
  let waits = 0

  while (!ctx.signal.aborted) {
    const stock = await readOffer(ctx, jar, itemId)
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
    if (!reading.inStock || !reading.offerId) {
      waits += 1
      const message = reading.offerId ? reading.reason : `${reading.reason} No offer id was returned.`
      ctx.detail(reading.title ? `${reading.title} · ${message}` : message)
      if (waits === 1 || waits % 10 === 0) ctx.log("info", message)
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }

    ctx.phase("in_stock")
    ctx.log("success", reading.reason)
    ctx.phase("adding_to_cart")
    const cart = await addToCart(ctx, jar, itemId, reading)
    if (cart.kind === "oos") {
      ctx.log("warn", "Add to cart reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (cart.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (cart.kind !== "ok") return asResult(cart)

    ctx.phase("checking_out")
    const shipped = await setShipToHome(ctx, jar, cart.value)
    if (shipped.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (shipped.kind !== "ok") return asResult(shipped)
    ctx.log("info", `Submitting payment for the card ending ${ctx.profile.last4}.`)
    const paid = await saveCard(ctx, jar)
    if (paid.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (paid.kind !== "ok") return asResult(paid)
    const contract = await createContract(ctx, jar, reading, cart.value, shipped.value, paid.value)
    if (contract.kind === "oos") {
      ctx.log("warn", "Checkout reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (contract.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (contract.kind !== "ok") return asResult(contract)
    const order = await placeOrder(ctx, jar, contract.value)
    if (order.kind === "oos") {
      ctx.log("warn", "Checkout reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (order.kind === "unauthorized") return pause(EXPIRED_PAUSE)
    if (order.kind !== "ok") return asResult(order)
    await clearLine(ctx, jar, cart.value, reading)
    const orderId = order.value
    return {
      outcome: "success",
      orderId,
      detail: orderId ? `Order ${orderId}` : "Walmart accepted the shipping order."
    }
  }
  return { outcome: "stopped", reason: "Stopped" }
}

async function readOffer(ctx: StoreRunContext, jar: CookieJar, itemId: string): Promise<Step<StockReading>> {
  const response = await call(ctx, {
    method: "POST",
    url: endpoint("home", "GetAllSellerOffers", OFFERS_HASH),
    headers: gqlHeaders(jar, "GetAllSellerOffers", "query", itemId),
    body: JSON.stringify({ variables: { itemId, isSubscriptionEligible: false } })
  })
  const primary = interpretMonitor(response)
  if (primary.kind === "paused" || primary.kind === "ok") return primary
  if (response.status === 429 || response.status >= 500) return primary
  const page = await call(ctx, {
    method: "GET",
    url: `https://www.walmart.com/ip/${itemId}`,
    headers: pageHeaders(jar, itemId)
  })
  if (isChallenge(page.status, page.body)) return { kind: "paused", reason: WALMART_PAUSE }
  if (page.status === 429 || page.status >= 500) {
    return { kind: "retry", reason: `Product page returned HTTP ${page.status}. Retrying.` }
  }
  const reading = readStock(page.body)
  if (reading) return { kind: "ok", value: reading }
  if (page.status === 404) {
    return { kind: "ok", value: { inStock: false, status: "NOT_FOUND", reason: "Item was not found." } }
  }
  return { kind: "retry", reason: `Monitor returned HTTP ${response.status} without a stock reading.` }
}

function interpretMonitor(response: HttpResponse): Step<StockReading> {
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: WALMART_PAUSE }
  if (response.status === 429 || response.status >= 500) {
    return { kind: "retry", reason: `Monitor request returned HTTP ${response.status}. Retrying.` }
  }
  const reading = readStock(response.body)
  if (reading) return { kind: "ok", value: reading }
  return { kind: "retry", reason: `Monitor returned HTTP ${response.status} without a stock reading.` }
}

async function probeCart(ctx: StoreRunContext, jar: CookieJar): Promise<Step<true>> {
  const response = await gql(ctx, jar, "home", "getCart", CART_HASH, "query", cartVariables(null), undefined, true)
  if (response.kind !== "ok") return response
  if (isChallenge(response.value.status, response.value.body)) return { kind: "paused", reason: WALMART_PAUSE }
  if (isUnauthorized(response.value.status, response.value.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  if (response.value.status >= 200 && response.value.status < 300) return { kind: "ok", value: true }
  if (response.value.status === 400 || response.value.status === 404) return { kind: "ok", value: true }
  ctx.log("warn", `Cart probe returned HTTP ${response.value.status}. Continuing with the saved session.`)
  return { kind: "ok", value: true }
}

async function addToCart(ctx: StoreRunContext, jar: CookieJar, itemId: string, reading: StockReading): Promise<Step<string>> {
  const lookedUp = await gql(ctx, jar, "home", "getCart", CART_HASH, "query", cartVariables(null), itemId)
  if (lookedUp.kind !== "ok") return lookedUp
  const cartId = findCartId(lookedUp.value.body)
  const response = await gql(ctx, jar, "home", "updateItems", UPDATE_ITEMS_HASH, "mutation", itemVariables(cartId, reading, ctx.task.quantity), itemId)
  if (response.kind !== "ok") return response
  if (outOfStock(response.value)) return { kind: "oos", reason: "Out of stock" }
  const nextId = findCartId(response.value.body) ?? cartId
  if ((response.value.status === 200 || response.value.status === 201) && nextId && !graphqlMessage(response.value.body)) {
    ctx.log("success", `Added ${ctx.task.quantity} to cart.`)
    return { kind: "ok", value: nextId }
  }
  if (nextId && !graphqlMessage(response.value.body) && response.value.status >= 200 && response.value.status < 300) {
    return { kind: "ok", value: nextId }
  }
  return { kind: "failed", reason: `Add to cart failed (${response.value.status}): ${snippet(response.value.body)}` }
}

async function setShipToHome(ctx: StoreRunContext, jar: CookieJar, cartId: string): Promise<Step<string>> {
  const fulfillment = await gql(
    ctx,
    jar,
    "cartxo",
    "updateFulfillmentOption",
    FULFILLMENT_HASH,
    "mutation",
    {
      input: {
        cartId,
        fulfillmentOption: "SHIPPING",
        enableLiquorBox: true,
        enableCartSplitClarity: false,
        features: []
      },
      includePartialFulfillmentSwitching: true,
      enableAEBadge: false,
      includeExpressSla: true,
      enableACCScheduling: false
    }
  )
  if (fulfillment.kind !== "ok") return fulfillment
  if (pickupOnly(fulfillment.value.body)) return { kind: "failed", reason: "Walmart is not offering ship-to-home for this item. v1 does not place pickup orders." }
  if (fulfillment.value.status < 200 || fulfillment.value.status >= 300 || graphqlMessage(fulfillment.value.body)) {
    return { kind: "failed", reason: `Shipping fulfillment was rejected (${fulfillment.value.status}): ${snippet(fulfillment.value.body)}` }
  }
  ctx.log("info", "Set fulfillment to shipping.")
  const ship = ctx.profile.shipping
  const names = splitName(ctx.profile.card.name || `${ship.firstName} ${ship.lastName}`)
  const created = await gql(ctx, jar, "home", "CreateDeliveryAddress", ADDRESS_HASH, "mutation", {
    input: {
      address: {
        addressLineOne: ship.line1,
        addressLineTwo: ship.line2,
        city: ship.city,
        state: ship.state,
        postalCode: ship.zip,
        country: "US",
        firstName: ship.firstName,
        lastName: ship.lastName,
        phone: ctx.profile.phone,
        isDefault: false
      },
      firstName: names.first,
      lastName: names.last,
      phone: ctx.profile.phone,
      isDefault: false,
      overrideAvs: true
    },
    fetchCAMSFields: false,
    enableProfileAddressLatLongSource: false,
    fetchMXFields: false,
    enableFamilySharingPage: false,
    fetchCAFields: false,
    fetchBusinessNameField: false,
    enableGEPKYC: false
  })
  if (created.kind !== "ok") return created
  const addressId = findAddressId(created.value.body)
  if (!addressId) return { kind: "failed", reason: `Walmart did not save the shipping address (${created.value.status}).` }
  const assigned = await gql(ctx, jar, "home", "setShipping", SET_SHIPPING_HASH, "mutation", {
    cartId,
    addressId,
    fetchCartFragment: true,
    features: [],
    enableLiquorBox: true,
    includePartialFulfillmentSwitching: true,
    enablePrebookDelivery: false,
    enableComplianceInfo: false
  })
  if (assigned.kind !== "ok") return assigned
  if (pickupOnly(assigned.value.body)) return { kind: "failed", reason: "Walmart is not offering ship-to-home for this item. v1 does not place pickup orders." }
  if (assigned.value.status < 200 || assigned.value.status >= 300) {
    return { kind: "failed", reason: `Shipping address was rejected (${assigned.value.status}): ${snippet(assigned.value.body)}` }
  }
  ctx.log("success", `Shipping address set for ${ship.city}, ${ship.state}.`)
  return { kind: "ok", value: addressId }
}

async function saveCard(ctx: StoreRunContext, jar: CookieJar): Promise<Step<string>> {
  const card = ctx.profile.card
  const bill = ctx.profile.billing
  const names = splitName(card.name)
  const response = await gql(
    ctx,
    jar,
    "home",
    "CreateAccountCreditCard",
    CARD_HASH,
    "mutation",
    {
      input: {
        firstName: names.first,
        lastName: names.last,
        expiryMonth: card.expMonth,
        expiryYear: card.expYear,
        isDefault: false,
        phone: ctx.profile.phone,
        cardType: cardBrand(card.number),
        encryptedPan: card.number,
        encryptedCVV: card.cvv,
        address: {
          addressLineOne: bill.line1,
          addressLineTwo: bill.line2,
          city: bill.city,
          state: bill.state,
          postalCode: bill.zip,
          country: "US"
        }
      }
    },
    undefined,
    false,
    true
  )
  if (response.kind !== "ok") return response
  const paymentId = findPaymentId(response.value.body)
  if (!paymentId || response.value.status < 200 || response.value.status >= 300) {
    return { kind: "failed", reason: `Payment was rejected (${response.value.status}): ${snippet(response.value.body)}` }
  }
  ctx.log("success", "Payment submitted to Walmart.")
  return { kind: "ok", value: paymentId }
}

async function createContract(
  ctx: StoreRunContext,
  jar: CookieJar,
  reading: StockReading,
  cartId: string,
  addressId: string,
  paymentId: string
): Promise<Step<string>> {
  const response = await gql(ctx, jar, "cartxo", "CreateBuyNowContract", BUY_NOW_HASH, "mutation", {
    cartId,
    items: [{ offerId: reading.offerId, usItemId: reading.usItemId, quantity: ctx.task.quantity }],
    shippingPreferenceId: addressId,
    paymentPreferenceId: paymentId,
    isBuyNow: true
  })
  if (response.kind !== "ok") return response
  if (outOfStock(response.value)) return { kind: "oos", reason: "Out of stock" }
  const contractId = findContractId(response.value.body)
  if (!contractId) return { kind: "failed", reason: `Walmart did not open a checkout contract (${response.value.status}).` }
  return { kind: "ok", value: contractId }
}

async function placeOrder(ctx: StoreRunContext, jar: CookieJar, contractId: string): Promise<Step<string | undefined>> {
  let response = await gql(ctx, jar, "cartxo", "placeOrder", PLACE_ORDER_HASH, "mutation", placeVariables(ctx, contractId))
  if (response.kind !== "ok") return response
  if (needsCvv(response.value.body) && (response.value.status >= 400 || !findOrderId(response.value.body))) {
    ctx.log("info", "Walmart asked for the CVV again. Resubmitting the card.")
    const card = await saveCard(ctx, jar)
    if (card.kind !== "ok") return card
    response = await gql(ctx, jar, "cartxo", "placeOrder", PLACE_ORDER_HASH, "mutation", placeVariables(ctx, contractId))
    if (response.kind !== "ok") return response
  }
  if (outOfStock(response.value)) return { kind: "oos", reason: "Out of stock" }
  if (bodyHas(response.value.body, "PAYMENT_DECLINED") || bodyHas(response.value.body, "payment_declined")) {
    return { kind: "failed", reason: "Walmart declined the card." }
  }
  const orderId = findOrderId(response.value.body)
  const message = graphqlMessage(response.value.body)
  if (orderId) return { kind: "ok", value: orderId }
  if (response.value.status >= 200 && response.value.status < 300 && !message && bodyHas(response.value.body, "placeOrder")) {
    return { kind: "ok", value: undefined }
  }
  return { kind: "failed", reason: `Checkout failed (${response.value.status}): ${snippet(response.value.body)}` }
}

async function clearLine(ctx: StoreRunContext, jar: CookieJar, cartId: string, reading: StockReading): Promise<void> {
  const response = await gql(ctx, jar, "home", "updateItems", UPDATE_ITEMS_HASH, "mutation", itemVariables(cartId, reading, 0))
  if (response.kind === "ok" && response.value.status >= 200 && response.value.status < 300) {
    ctx.log("info", "Cleared the cart line after checkout.")
  }
}

function placeVariables(ctx: StoreRunContext, contractId: string): Record<string, unknown> {
  return {
    placeOrderInput: {
      contractId,
      emailAddress: ctx.profile.email,
      mobileNumber: ctx.profile.phone,
      acceptSMSOptInDisclosure: false,
      acceptAutoOrderDisclosure: false,
      acceptRecurringBillingDisclosure: false,
      utensilSelected: false
    }
  }
}

function cartVariables(cartId: string | null): Record<string, unknown> {
  return {
    cartInput: {
      cartId,
      forceRefresh: false,
      enableLiquorBox: true,
      enableCartSplitClarity: false,
      features: []
    },
    includePartialFulfillmentSwitching: true,
    enableAEBadge: false,
    includeExpressSla: true,
    enableACCScheduling: false
  }
}

function itemVariables(cartId: string | undefined, reading: StockReading, quantity: number): Record<string, unknown> {
  return {
    input: {
      cartId: cartId ?? null,
      items: [{ offerId: reading.offerId, usItemId: reading.usItemId, quantity, name: reading.title ?? "Item" }],
      enableCartSplitClarity: false,
      features: []
    },
    includePartialFulfillmentSwitching: true,
    enableAEBadge: false,
    includeExpressSla: true,
    enableACCScheduling: false
  }
}

async function gql(
  ctx: StoreRunContext,
  jar: CookieJar,
  gateway: "home" | "cartxo",
  name: string,
  hash: string,
  operation: "query" | "mutation",
  variables: Record<string, unknown>,
  itemId?: string,
  quiet = false,
  carriesCard = false
): Promise<Step<HttpResponse>> {
  const response = await call(
    ctx,
    {
      method: "POST",
      url: endpoint(gateway, name, hash),
      headers: gqlHeaders(jar, name, operation, itemId),
      body: JSON.stringify({ variables })
    },
    carriesCard
  )
  rememberSession(ctx, jar, response, quiet)
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: WALMART_PAUSE }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  return { kind: "ok", value: response }
}

function rememberSession(ctx: StoreRunContext, jar: CookieJar, response: HttpResponse, quiet: boolean): void {
  const raw = response.headers["set-cookie"]
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : []
  let changed = false
  for (const cookie of cookies) {
    const pair = cookie.split(";")[0] ?? ""
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name === "auth" && value && value !== jar.accessToken) {
      jar.accessToken = value
      changed = true
    }
    if ((name === "CID" || name === "cid") && value && value !== jar.visitorId) {
      jar.visitorId = value
      changed = true
    }
  }
  if (changed && !quiet) void ctx.onSession(jar.toSession())
}

async function call(ctx: StoreRunContext, request: HttpRequest, carriesCard = false): Promise<HttpResponse> {
  const host = new URL(request.url).hostname
  if (!ALLOWED_HOSTS.has(host)) throw new Error(`Refusing to contact ${host}.`)
  if (carriesCard && host !== "www.walmart.com") throw new Error("Card data can only be sent to the retailer.")
  return ctx.http.request({ ...request, proxy: ctx.proxy, signal: ctx.signal })
}

function endpoint(gateway: "home" | "cartxo", name: string, hash: string): string {
  return `https://www.walmart.com/orchestra/${gateway}/graphql/${name}/${hash}`
}

function gqlHeaders(jar: CookieJar, name: string, operation: "query" | "mutation", itemId?: string): Record<string, string> {
  const referer = itemId ? `https://www.walmart.com/ip/${itemId}` : "https://www.walmart.com/cart"
  const trace = randomBytes(16).toString("hex")
  const span = randomBytes(8).toString("hex")
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.walmart.com",
    referer,
    "user-agent": USER_AGENT,
    "x-apollo-operation-name": name,
    "x-o-gql-query": `${operation} ${name}`,
    "x-o-platform": "rweb",
    "x-o-platform-version": "usweb-1.256.1",
    "x-o-mart": "B2C",
    "x-o-bu": "WALMART-US",
    "x-o-segment": "oaoh",
    "x-o-ccm": "server",
    "x-latency-trace": "1",
    "tenant-id": "elh9ie",
    wm_mp: "true",
    "wm_qos.correlation_id": trace,
    "x-o-correlation-id": trace,
    "wm-client-traceid": trace,
    traceparent: `00-${trace}-${span}-00`,
    wm_page_url: referer
  }
  const cookie = jar.header()
  if (cookie) headers.cookie = cookie
  return headers
}

function pageHeaders(jar: CookieJar, itemId: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": USER_AGENT,
    referer: "https://www.walmart.com/"
  }
  const cookie = jar.header()
  if (cookie) headers.cookie = cookie
  headers["wm_page_url"] = `https://www.walmart.com/ip/${itemId}`
  return headers
}

function outOfStock(response: HttpResponse): boolean {
  return bodyHas(response.body, "OUT_OF_STOCK") || bodyHas(response.body, "out of stock") || bodyHas(response.body, "ITEM_UNAVAILABLE")
}

function pickupOnly(body: string): boolean {
  return bodyHas(body, "NOT_SOLD_FOR_SHIP") || bodyHas(body, "PICKUP_ONLY") || bodyHas(body, "not available for shipping")
}

function needsCvv(body: string): boolean {
  return bodyHas(body, "cvv")
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
