import { attachSession, isBlockStatus, sendWithRecovery } from "../../engine/block-recovery"
import { redact } from "../../shared/redact"
import type { SessionCookies } from "../../shared/types"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import type { StoreModule, StoreRunContext, StoreRunResult } from "../module"
import { createCardJwe, readFlexContext, readPaymentToken } from "./card"
import {
  isChallenge,
  isGuestCart,
  isProductUrl,
  isQueueHost,
  isUnauthorized,
  parseSku,
  productUrl,
  readEnqueue,
  readOrderId,
  readQueueStatus,
  readQueueTarget,
  readShippingMethods,
  readStock,
  searchUrl,
  type QueueTarget,
  type StockReading
} from "./parse"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
const STORE_HOST = "www.pokemoncenter.com"
const FLEX_HOST = "flex.cybersource.com"

export const POKEMON_CENTER_PAUSE =
  "Pokémon Center presented a challenge (DataDome, Incapsula, or a captcha). Finish it in your own browser, paste a fresh session if needed, then resume. TCGAIO does not solve challenges."

const QUEUE_CAPTCHA_PAUSE =
  "Pokémon Center's waiting room asked for a captcha. Finish it in your own browser, then resume. TCGAIO does not solve challenges."
const SESSION_PAUSE =
  "Paste a signed-in Pokémon Center browser session (the cookie header from www.pokemoncenter.com). Password sign-in is blocked by Incapsula, and TCGAIO does not solve challenges."
const EXPIRED_PAUSE = "The Pokémon Center session expired. Paste a fresh cookie header, then resume."
const GUEST_PAUSE = "The Pokémon Center session is not signed in. Paste the cookie header from a signed-in browser, then resume."

class CookieJar {
  private cookies = new Map<string, string>()
  private queueNames = new Set<string>()

  load(session?: SessionCookies): void {
    if (session?.cookie) this.merge(session.cookie)
    else if (session?.accessToken && session.accessToken !== "session") this.cookies.set("accessToken", session.accessToken)
  }

  absorb(headers: HttpResponse["headers"], fromQueue: boolean): boolean {
    const value = headers["set-cookie"]
    const list = Array.isArray(value) ? value : value ? [value] : []
    let changed = false
    for (const cookie of list) {
      const pair = cookie.split(";")[0]?.trim() ?? ""
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const next = pair.slice(eq + 1).trim()
      if (fromQueue || name.toLowerCase().startsWith("queueit")) this.queueNames.add(name)
      if (this.cookies.get(name) !== next) {
        this.cookies.set(name, next)
        changed = true
      }
    }
    return changed
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
  }

  queueHeader(): string {
    return [...this.cookies.entries()].filter(([name]) => this.queueNames.has(name)).map(([name, value]) => `${name}=${value}`).join("; ")
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
  kind: "paused" | "failed" | "oos" | "unauthorized" | "retry"
  reason: string
}
type Step<T> = StepOk<T> | StepStop

export function createPokemonCenterModule(): StoreModule {
  return {
    id: "pokemon-center",
    displayName: "Pokémon Center",
    skuHint: "SKU or product URL",
    implemented: true,
    run: (ctx) => runPokemonCenter(ctx)
  }
}

async function runPokemonCenter(ctx: StoreRunContext): Promise<StoreRunResult> {
  const sku = parseSku(ctx.task.sku)
  if (!sku) return fail("Enter a Pokémon Center SKU or a product URL from www.pokemoncenter.com/product/.")
  if (ctx.profile.shipping.country !== "US") return fail("v1 places US ship-to-home orders only.")
  if (ctx.account.store !== "pokemon-center") return fail("Choose a Pokémon Center account.")
  if (!ctx.account.session?.cookie && !ctx.account.session?.accessToken) return pause(SESSION_PAUSE)

  const jar = new CookieJar()
  jar.load(ctx.account.session)
  attachSession(ctx, (cookies) => jar.load(cookies))
  ctx.log("info", "Using the saved Pokémon Center session.")
  const probe = await probeCart(ctx, jar)
  if (probe.kind !== "ok") return asResult(probe)

  const page = productUrl(ctx.task.sku, sku)
  ctx.phase("monitoring")
  ctx.log("info", `Watching SKU ${sku} for Pokémon Center availability.`)
  let waits = 0

  while (!ctx.signal.aborted) {
    const stock = await readOffer(ctx, jar, sku, page)
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
      waits += 1
      ctx.detail(reading.reason)
      if (waits === 1 || waits % 10 === 0) ctx.log("info", reading.reason)
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }

    ctx.phase("in_stock")
    ctx.log("success", reading.reason)
    ctx.phase("adding_to_cart")
    const cart = await addToCart(ctx, jar, reading, page)
    if (cart.kind === "oos") {
      ctx.log("warn", "Add to cart reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (cart.kind !== "ok") return asResult(cart)

    ctx.phase("checking_out")
    const shipped = await shipToHome(ctx, jar, page)
    if (shipped.kind !== "ok") return asResult(shipped)
    ctx.log("info", `Submitting payment for the card ending ${ctx.profile.last4}.`)
    const paid = await pay(ctx, jar, page)
    if (paid.kind === "oos") {
      ctx.log("warn", "Checkout reported the item unavailable. Returning to the monitor.")
      ctx.phase("monitoring")
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    if (paid.kind !== "ok") return asResult(paid)
    const orderId = paid.value
    return {
      outcome: "success",
      orderId,
      detail: orderId ? `Order ${orderId}` : "Pokémon Center accepted the shipping order."
    }
  }
  return { outcome: "stopped", reason: "Stopped" }
}

async function readOffer(ctx: StoreRunContext, jar: CookieJar, sku: string, page: string): Promise<Step<StockReading>> {
  const primary = isProductUrl(ctx.task.sku, sku) ? page : searchUrl(sku)
  const response = await store(ctx, jar, { method: "GET", url: primary, headers: pageHeaders(jar, page) })
  if (response.kind === "retry") return response
  if (response.kind !== "ok") return response
  if (response.value.status === 429 || response.value.status >= 500) {
    return { kind: "retry", reason: `Monitor request returned HTTP ${response.value.status}. Retrying.` }
  }
  let reading = readStock(response.value.body, sku)
  const searchMiss = reading?.status === "NOT_FOUND" && !isProductUrl(ctx.task.sku, sku)
  if ((!reading || searchMiss) && !isProductUrl(ctx.task.sku, sku)) {
    const fallback = await store(ctx, jar, { method: "GET", url: page, headers: pageHeaders(jar, page) })
    if (fallback.kind !== "ok") return fallback
    if (fallback.value.status === 429 || fallback.value.status >= 500) {
      return { kind: "retry", reason: `Monitor request returned HTTP ${fallback.value.status}. Retrying.` }
    }
    const pageReading = readStock(fallback.value.body, sku)
    if (pageReading) reading = pageReading
    if (!reading && fallback.value.status === 404) {
      return { kind: "ok", value: { inStock: false, status: "NOT_FOUND", sku, productUri: page, availability: "NOT_FOUND", reason: "SKU was not found." } }
    }
  }
  if (reading) return { kind: "ok", value: reading }
  if (response.value.status === 404) {
    return { kind: "ok", value: { inStock: false, status: "NOT_FOUND", sku, productUri: page, availability: "NOT_FOUND", reason: "SKU was not found." } }
  }
  return { kind: "retry", reason: `Monitor returned HTTP ${response.value.status} without a stock reading.` }
}

async function probeCart(ctx: StoreRunContext, jar: CookieJar): Promise<Step<true>> {
  const response = await store(ctx, jar, {
    method: "GET",
    url: "https://www.pokemoncenter.com/tpci-ecommweb-api/cart?format=nodatalinks",
    headers: jsonHeaders(jar, "https://www.pokemoncenter.com/cart")
  })
  if (response.kind !== "ok") return response
  if (isGuestCart(response.value.body)) return { kind: "paused", reason: GUEST_PAUSE }
  if (response.value.status >= 200 && response.value.status < 300) return { kind: "ok", value: true }
  ctx.log("warn", `Cart probe returned HTTP ${response.value.status}. Continuing with the saved session.`)
  return { kind: "ok", value: true }
}

async function addToCart(ctx: StoreRunContext, jar: CookieJar, reading: StockReading, page: string): Promise<Step<true>> {
  const response = await store(ctx, jar, {
    method: "POST",
    url: "https://www.pokemoncenter.com/tpci-ecommweb-api/cart?type=product&format=nodatalinks",
    headers: jsonHeaders(jar, page),
    body: JSON.stringify({ productURI: reading.productUri, quantity: ctx.task.quantity, configuration: {} })
  })
  if (response.kind !== "ok") return response
  if (outOfStock(response.value.body) || response.value.status === 409) return { kind: "oos", reason: "Out of stock" }
  if (response.value.status < 200 || response.value.status >= 300) {
    return { kind: "failed", reason: `Add to cart was rejected (${response.value.status}): ${snippet(response.value.body)}` }
  }
  ctx.log("success", "Added to the Pokémon Center cart.")
  return { kind: "ok", value: true }
}

async function shipToHome(ctx: StoreRunContext, jar: CookieJar, page: string): Promise<Step<true>> {
  const shipping = ctx.profile.shipping
  const addressed = await store(ctx, jar, {
    method: "POST",
    url: "https://www.pokemoncenter.com/tpci-ecommweb-api/cart/shipping-address?format=nodatalinks",
    headers: jsonHeaders(jar, page),
    body: JSON.stringify({
      firstName: shipping.firstName,
      lastName: shipping.lastName,
      address1: shipping.line1,
      address2: shipping.line2,
      city: shipping.city,
      state: shipping.state,
      postalCode: shipping.zip,
      country: "US",
      phone: ctx.profile.phone,
      email: ctx.profile.email,
      isDefault: false
    })
  })
  if (addressed.kind !== "ok") return addressed
  if (addressed.value.status < 200 || addressed.value.status >= 300) {
    return { kind: "failed", reason: `Shipping address was rejected (${addressed.value.status}): ${snippet(addressed.value.body)}` }
  }
  let methods = readShippingMethods(addressed.value.body)
  if (!methods.length) {
    const listed = await store(ctx, jar, {
      method: "GET",
      url: "https://www.pokemoncenter.com/tpci-ecommweb-api/cart/shipping-methods?format=nodatalinks",
      headers: jsonHeaders(jar, page)
    })
    if (listed.kind !== "ok") return listed
    if (listed.value.status < 200 || listed.value.status >= 300) {
      return { kind: "failed", reason: `Shipping methods were rejected (${listed.value.status}): ${snippet(listed.value.body)}` }
    }
    methods = readShippingMethods(listed.value.body)
  }
  const choice = methods.find((method) => !method.pickup)
  if (!choice) {
    if (methods.some((method) => method.pickup)) {
      return { kind: "failed", reason: "Pokémon Center is not offering ship-to-home for this item. v1 does not place pickup orders." }
    }
    return { kind: "failed", reason: "Pokémon Center did not return a shipping method." }
  }
  const selected = await store(ctx, jar, {
    method: "POST",
    url: "https://www.pokemoncenter.com/tpci-ecommweb-api/cart/shipping-method?format=nodatalinks",
    headers: jsonHeaders(jar, page),
    body: JSON.stringify({ shippingMethodId: choice.id })
  })
  if (selected.kind !== "ok") return selected
  if (selected.value.status < 200 || selected.value.status >= 300) {
    return { kind: "failed", reason: `Shipping method was rejected (${selected.value.status}): ${snippet(selected.value.body)}` }
  }
  ctx.log("info", `Shipping with ${choice.name}.`)
  return { kind: "ok", value: true }
}

async function pay(ctx: StoreRunContext, jar: CookieJar, page: string): Promise<Step<string | undefined>> {
  const keyResponse = await store(ctx, jar, {
    method: "GET",
    url: "https://www.pokemoncenter.com/tpci-ecommweb-api/get-payment-iframe-key?microform=true&locale=en-GB",
    headers: jsonHeaders(jar, page)
  })
  if (keyResponse.kind !== "ok") return keyResponse
  if (keyResponse.value.status < 200 || keyResponse.value.status >= 300) {
    return { kind: "failed", reason: `Pokémon Center did not return a payment key (HTTP ${keyResponse.value.status}).` }
  }
  const keyId = readKeyId(keyResponse.value.body)
  if (!keyId) return { kind: "failed", reason: "Pokémon Center's payment key response could not be read." }
  let jwe = ""
  let tokenUrl = ""
  try {
    tokenUrl = readFlexContext(keyId).tokenUrl
    jwe = createCardJwe(keyId, {
      number: ctx.profile.card.number,
      securityCode: ctx.profile.card.cvv,
      expirationMonth: ctx.profile.card.expMonth,
      expirationYear: ctx.profile.card.expYear
    })
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : "The card could not be encrypted." }
  }
  const tokenResponse = await cardCall(ctx, {
    method: "POST",
    url: tokenUrl,
    headers: {
      accept: "application/jwt",
      "content-type": "application/jwt; charset=utf-8",
      "user-agent": USER_AGENT
    },
    body: jwe
  })
  if (isChallenge(tokenResponse.status, tokenResponse.body)) return { kind: "paused", reason: POKEMON_CENTER_PAUSE }
  if (tokenResponse.status < 200 || tokenResponse.status >= 300) {
    return { kind: "failed", reason: `CyberSource Flex rejected the card token (${tokenResponse.status}).` }
  }
  const paymentToken = readPaymentToken(tokenResponse.body)
  if (!paymentToken) return { kind: "failed", reason: "CyberSource Flex did not return a payment token." }
  const order = await store(ctx, jar, {
    method: "POST",
    url: "https://www.pokemoncenter.com/tpci-ecommweb-api/order?format=nodatalinks",
    headers: jsonHeaders(jar, page),
    body: JSON.stringify({ paymentKey: keyId, paymentToken, email: ctx.profile.email })
  })
  if (order.kind !== "ok") return order
  if (outOfStock(order.value.body)) return { kind: "oos", reason: "Out of stock" }
  if (declined(order.value.body)) return { kind: "failed", reason: "Pokémon Center declined the card." }
  const orderId = readOrderId(order.value.body)
  if (order.value.status >= 200 && order.value.status < 300 && orderId) {
    ctx.log("success", "Pokémon Center accepted the order.")
    return { kind: "ok", value: orderId }
  }
  return { kind: "failed", reason: `Checkout failed (${order.value.status}): ${snippet(order.value.body)}` }
}

async function store(ctx: StoreRunContext, jar: CookieJar, request: HttpRequest): Promise<Step<HttpResponse>> {
  const response = await send(ctx, jar, { ...request, redirect: "manual" }, "store")
  const location = header(response, "location")
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: POKEMON_CENTER_PAUSE }
  const queue = readQueueTarget(response.status, response.body, location)
  if (queue) {
    const waited = await waitInQueue(ctx, jar, queue)
    if (waited.kind !== "ok") return waited
    if (ctx.signal.aborted) return { kind: "failed", reason: "Stopped" }
    const again = await send(ctx, jar, { ...request, redirect: "manual" }, "store")
    if (isChallenge(again.status, again.body)) return { kind: "paused", reason: POKEMON_CENTER_PAUSE }
    if (readQueueTarget(again.status, again.body, header(again, "location"))) {
      return { kind: "paused", reason: "Pokémon Center returned to the waiting room after a pass. Resume after the line clears." }
    }
    if (isUnauthorized(again.status, again.body)) return { kind: "unauthorized", reason: "Unauthorized" }
    return { kind: "ok", value: again }
  }
  if (isUnauthorized(response.status, response.body)) return { kind: "unauthorized", reason: "Unauthorized" }
  return { kind: "ok", value: response }
}

async function waitInQueue(ctx: StoreRunContext, jar: CookieJar, target: QueueTarget): Promise<Step<true>> {
  const enqueueUrl = `https://${target.host}/spa-api/queue/${encodeURIComponent(target.customerId)}/${encodeURIComponent(target.eventId)}/enqueue?cid=en-US`
  const enqueued = await send(ctx, jar, {
    method: "POST",
    url: enqueueUrl,
    headers: queueHeaders(target),
    body: JSON.stringify({
      challengeSessions: [],
      layoutName: target.layoutName,
      customUrlParams: "",
      targetUrl: target.targetUrl,
      Referrer: "https://www.pokemoncenter.com/"
    })
  }, "queue")
  if (isChallenge(enqueued.status, enqueued.body)) return { kind: "paused", reason: POKEMON_CENTER_PAUSE }
  const enqueue = readEnqueue(enqueued.body)
  if (enqueue.challenge) return { kind: "paused", reason: QUEUE_CAPTCHA_PAUSE }
  if (enqueue.redirectUrl) return followRedirect(ctx, jar, enqueue.redirectUrl)
  if (!enqueue.queueId) return { kind: "failed", reason: `Pokémon Center waiting room did not issue a ticket (${enqueued.status}).` }

  while (!ctx.signal.aborted) {
    const statusUrl = `https://${target.host}/spa-api/queue/${encodeURIComponent(target.customerId)}/${encodeURIComponent(target.eventId)}/${encodeURIComponent(enqueue.queueId)}/status?cid=en-US`
    const polled = await send(ctx, jar, {
      method: "POST",
      url: statusUrl,
      headers: queueHeaders(target),
      body: JSON.stringify({
        targetUrl: target.targetUrl,
        customUrlParams: "",
        layoutName: target.layoutName,
        isClientRedayToRedirect: true,
        isBeforeOrIdle: false
      })
    }, "queue")
    if (isChallenge(polled.status, polled.body)) return { kind: "paused", reason: POKEMON_CENTER_PAUSE }
    if (polled.status === 429 || polled.status >= 500) {
      ctx.log("warn", `Waiting room status returned HTTP ${polled.status}. Checking again.`)
      await ctx.sleep(ctx.settings.monitorDelayMs)
      continue
    }
    const ticket = readQueueStatus(polled.body)
    if (ticket.challenge) return { kind: "paused", reason: QUEUE_CAPTCHA_PAUSE }
    if (ticket.redirectUrl) return followRedirect(ctx, jar, ticket.redirectUrl)
    const waitMs = ticket.updateIntervalMs !== undefined && ticket.updateIntervalMs >= 1000 && ticket.updateIntervalMs <= 120000
      ? ticket.updateIntervalMs
      : ctx.settings.monitorDelayMs
    const ahead = ticket.ahead ?? "unknown"
    const seconds = Math.max(1, Math.round(waitMs / 1000))
    ctx.log("info", `Pokémon Center waiting room. Ahead of you: ${ahead}. Checking again in ${seconds}s.`)
    ctx.detail(`Waiting room. Ahead of you: ${ahead}.`)
    await ctx.sleep(waitMs)
  }
  return { kind: "failed", reason: "Stopped" }
}

async function followRedirect(ctx: StoreRunContext, jar: CookieJar, redirectUrl: string): Promise<Step<true>> {
  let url: URL
  try {
    url = new URL(redirectUrl)
  } catch {
    return { kind: "failed", reason: "The waiting room returned an invalid redirect." }
  }
  if (url.hostname !== STORE_HOST) return { kind: "failed", reason: "The waiting room redirected away from www.pokemoncenter.com." }
  const response = await send(ctx, jar, {
    method: "GET",
    url: url.toString(),
    headers: pageHeaders(jar, "https://www.pokemoncenter.com/"),
    redirect: "manual"
  }, "store")
  if (isChallenge(response.status, response.body)) return { kind: "paused", reason: POKEMON_CENTER_PAUSE }
  ctx.log("info", "Pokémon Center waiting room let the session through.")
  return { kind: "ok", value: true }
}

async function send(ctx: StoreRunContext, jar: CookieJar, request: HttpRequest, purpose: "store" | "queue"): Promise<HttpResponse> {
  assertHost(request.url, purpose)
  const headers = { ...request.headers }
  if (purpose === "queue") {
    const cookie = jar.queueHeader()
    if (cookie) headers.cookie = cookie
    else delete headers.cookie
  }
  const response = await sendWithRecovery(ctx, { ...request, headers }, {
    homeUrl: "https://www.pokemoncenter.com/",
    blocked: (result) => isBlockStatus(result.status, result) || isChallenge(result.status, result.body)
  })
  if (jar.absorb(response.headers, purpose === "queue")) {
    await ctx.onSession({
      accessToken: ctx.account.session?.accessToken || "session",
      visitorId: ctx.account.session?.visitorId,
      refreshToken: ctx.account.session?.refreshToken,
      idToken: ctx.account.session?.idToken,
      cookie: jar.header()
    })
  }
  return response
}

async function cardCall(ctx: StoreRunContext, request: HttpRequest): Promise<HttpResponse> {
  const host = new URL(request.url).hostname
  if (host !== FLEX_HOST) throw new Error("Card data can only be sent to flex.cybersource.com.")
  return ctx.http.request({ ...request, proxy: ctx.proxy, signal: ctx.signal })
}

function assertHost(url: string, purpose: "store" | "queue"): void {
  const host = new URL(url).hostname
  if (purpose === "queue") {
    if (!isQueueHost(host)) throw new Error(`Refusing to contact ${host}.`)
    return
  }
  if (host !== STORE_HOST) throw new Error(`Refusing to contact ${host}.`)
}

function pageHeaders(jar: CookieJar, referer: string): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/json",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": USER_AGENT,
    referer,
    cookie: jar.header()
  }
}

function jsonHeaders(jar: CookieJar, referer: string): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: "https://www.pokemoncenter.com",
    referer,
    "user-agent": USER_AGENT,
    cookie: jar.header()
  }
}

function queueHeaders(target: QueueTarget): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    "accept-language": "en-US,en;q=0.9",
    origin: `https://${target.host}`,
    referer: `https://${target.host}/`,
    "user-agent": USER_AGENT
  }
}

function readKeyId(body: string): string | undefined {
  const record = asRecord(safeJson(body))
  const key = record?.keyId
  return typeof key === "string" && key.trim() ? key.trim() : undefined
}

function outOfStock(body: string): boolean {
  const text = body.toLowerCase()
  return text.includes("out_of_stock") || text.includes("sold_out") || text.includes("sold out") || text.includes("unavailable")
}

function declined(body: string): boolean {
  const text = body.toLowerCase()
  return text.includes("declined") || text.includes("payment_declined")
}

function header(response: HttpResponse, name: string): string {
  const value = response.headers[name] ?? response.headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
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
  if (step.kind === "unauthorized") return pause(EXPIRED_PAUSE)
  if (step.reason === "Stopped") return { outcome: "stopped", reason: "Stopped" }
  return { outcome: "failed", reason: step.reason }
}
