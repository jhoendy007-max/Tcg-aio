import { attachSession } from "../../engine/block-recovery"
import { holdMonitorOnly, monitorKey, noteWatch, sharedValue } from "../../engine/monitor"
import { productImage } from "../../shared/image"
import { finishTest, note } from "../../engine/test-mode"
import type { SessionCookies } from "../../shared/types"
import { chromeUserAgent } from "../../engine/chrome-ua"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import { paceAddToCart, retryWait, type StoreModule, type StoreRunContext, type StoreRunResult } from "../module"
import {
  cartError,
  isChallenge,
  isLoggedIn,
  outOfStockError,
  parseSku,
  productApiUrl,
  productPageUrl,
  readCart,
  readCsrf,
  readStock,
  type CartReading,
  type StockReading
} from "./parse"

const ORIGIN = "https://p-bandai.com"

export const BANDAI_PAUSE =
  "Premium Bandai presented a challenge. Finish it in your own browser, paste a fresh session if needed, then resume. TCGAIO does not solve challenges."

const SESSION_PAUSE =
  "Paste a signed-in Premium Bandai session (the p-bandai.com cookie header) or use Sign in on the Session Keeper page. TCGAIO does not solve challenges."
const EXPIRED_PAUSE = "The Premium Bandai session expired. Sign in again on the Session Keeper page, then resume."
const GUEST_PAUSE = "The Premium Bandai session is not signed in. Sign in on the Session Keeper page, then resume."
const PAYMENT_PAUSE =
  "Premium Bandai started the checkout. Global-e collects the card on the order page. Finish payment in the account browser. The card number was not sent, and the order confirmation was not submitted."

class CookieJar {
  private cookies = new Map<string, string>()
  csrf = ""

  load(session?: SessionCookies): void {
    if (session?.cookie) this.merge(session.cookie)
  }

  absorb(headers: HttpResponse["headers"]): boolean {
    const value = headers["set-cookie"]
    const list = Array.isArray(value) ? value : value ? [value] : []
    let changed = false
    for (const cookie of list) {
      const pair = cookie.split(";")[0]?.trim() ?? ""
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const next = pair.slice(eq + 1).trim()
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

export function createBandaiModule(): StoreModule {
  return {
    id: "bandai",
    displayName: "Premium Bandai",
    skuHint: "Product code or p-bandai.com item URL",
    implemented: true,
    run: (ctx) => runBandai(ctx)
  }
}

async function runBandai(ctx: StoreRunContext): Promise<StoreRunResult> {
  const sku = parseSku(ctx.task.sku)
  if (!sku) return fail("Enter a Premium Bandai product code or a p-bandai.com/us/item/ URL.")
  if (ctx.profile.shipping.country !== "US") return fail("v1 places US ship-to-home orders only.")
  if (ctx.account.store !== "bandai") return fail("Choose a Premium Bandai account.")
  if (!ctx.account.session?.cookie && !ctx.account.session?.accessToken) return pause(SESSION_PAUSE)

  const jar = new CookieJar()
  jar.load(ctx.account.session)
  attachSession(ctx, (cookies) => jar.load(cookies))
  const member = await store(ctx, jar, { method: "GET", url: `${ORIGIN}/api/context/member`, headers: apiHeaders(jar, `${ORIGIN}/us`) })
  if (member.kind !== "ok") return asResult(member)
  if (isChallenge(member.value.status, member.value.body)) return pause(BANDAI_PAUSE)
  if (member.value.status === 401) return pause(EXPIRED_PAUSE)
  jar.csrf = readCsrf(member.value.body)
  if (!isLoggedIn(member.value.body)) return pause(GUEST_PAUSE)
  ctx.log("info", "Using the saved Premium Bandai session.")
  note(ctx, "session", "pass", "Saved Premium Bandai session loaded.")

  const page = productPageUrl(sku)
  ctx.phase("monitoring")
  ctx.log("info", `Watching ${sku} on Premium Bandai.`)
  let waits = 0

  while (!ctx.signal.aborted) {
    const stock = await readOffer(ctx, jar, sku, page)
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
    await paceAddToCart(ctx)
    ctx.phase("adding_to_cart")
    const cart = await addToCart(ctx, jar, reading, page)
    if (cart.kind === "oos" || cart.kind === "retry") {
      ctx.log("warn", cart.reason)
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
    const started = await startCheckout(ctx, jar)
    if (started.kind === "retry") {
      ctx.log("warn", started.reason)
      ctx.phase("monitoring")
      await ctx.sleep(retryWait(ctx))
      continue
    }
    if (started.kind !== "ok") {
      note(ctx, "address", "fail", started.reason)
      return asResult(started)
    }
    note(ctx, "address", "pass", "The shipping address stays on the profile. Premium Bandai collects it in checkout.")
    note(ctx, "shipping", "pass", `Checkout ${started.value.checkoutSn} is ready.`)
    note(ctx, "payment", "skip", "Global-e collects the card on the order page. The card number was not sent.")
    if (ctx.testMode) {
      if (ctx.clearCartAfterTest) await clearLines(ctx, jar, started.value.lines, page)
      return finishTest(ctx)
    }
    return pause(`${PAYMENT_PAUSE} Checkout ${started.value.checkoutSn}.`)
  }
  return { outcome: "stopped", reason: "Stopped" }
}

async function readOffer(ctx: StoreRunContext, jar: CookieJar, sku: string, page: string): Promise<Step<StockReading>> {
  const response = await sharedValue(ctx, monitorKey("bandai", sku, "product", ctx.proxy), () => store(ctx, jar, { method: "GET", url: productApiUrl(sku), headers: apiHeaders(jar, page) }))
  if (response.kind !== "ok") return response
  if (isChallenge(response.value.status, response.value.body)) return { kind: "paused", reason: BANDAI_PAUSE }
  if (response.value.status === 401) return { kind: "unauthorized", reason: EXPIRED_PAUSE }
  if (response.value.status === 429 || response.value.status >= 500) {
    return { kind: "retry", reason: `Monitor request returned HTTP ${response.value.status}. Retrying.` }
  }
  const reading = readStock(response.value.body, sku)
  if (reading) {
    reading.imageUrl = productImage(response.value.body) || undefined
    noteWatch(ctx, { ...reading, url: page })
    return { kind: "ok", value: reading }
  }
  if (response.value.status === 404) {
    return { kind: "ok", value: { inStock: false, status: "NOT_FOUND", sku, maxQuantity: 1, reason: "Product was not found." } }
  }
  return { kind: "retry", reason: `Monitor returned HTTP ${response.value.status} without a stock reading.` }
}

async function addToCart(ctx: StoreRunContext, jar: CookieJar, reading: StockReading, page: string): Promise<Step<true>> {
  if (!reading.areaItemNo) return { kind: "failed", reason: "Premium Bandai did not name an item to add." }
  const qty = Math.max(1, Math.min(reading.maxQuantity, ctx.task.quantity))
  const response = await store(ctx, jar, {
    method: "POST",
    url: `${ORIGIN}/api/cart/addToCart`,
    headers: apiHeaders(jar, page, true),
    body: JSON.stringify([{ areaItemNo: reading.areaItemNo, qty }])
  })
  if (response.kind !== "ok") return response
  if (isChallenge(response.value.status, response.value.body)) return { kind: "paused", reason: BANDAI_PAUSE }
  if (response.value.status === 401) return { kind: "unauthorized", reason: EXPIRED_PAUSE }
  const code = cartError(response.value.body)
  if (outOfStockError(code)) return { kind: "oos", reason: "Add to cart reported the item unavailable." }
  if (response.value.status === 429 || response.value.status >= 500) {
    return { kind: "retry", reason: `Add to cart returned HTTP ${response.value.status}. Retrying.` }
  }
  if (response.value.status >= 400 || code) {
    return { kind: "failed", reason: `Add to cart failed (${code || `HTTP ${response.value.status}`}).` }
  }
  return { kind: "ok", value: true }
}

async function startCheckout(ctx: StoreRunContext, jar: CookieJar): Promise<Step<{ checkoutSn: string; lines: CartReading["lines"] }>> {
  const detail = await store(ctx, jar, { method: "GET", url: `${ORIGIN}/api/cart/detail`, headers: apiHeaders(jar, `${ORIGIN}/us/cart`) })
  if (detail.kind !== "ok") return detail
  if (isChallenge(detail.value.status, detail.value.body)) return { kind: "paused", reason: BANDAI_PAUSE }
  if (detail.value.status === 401) return { kind: "unauthorized", reason: EXPIRED_PAUSE }
  if (detail.value.status === 429 || detail.value.status >= 500) {
    return { kind: "retry", reason: `Cart request returned HTTP ${detail.value.status}. Retrying.` }
  }
  const cart = readCart(detail.value.body)
  if (!cart?.cartSn || !cart.lines.length) return { kind: "failed", reason: "The Premium Bandai cart has no line to check out." }
  const response = await store(ctx, jar, {
    method: "POST",
    url: `${ORIGIN}/api/cart/${encodeURIComponent(cart.cartSn)}/checkout`,
    headers: apiHeaders(jar, `${ORIGIN}/us/cart`, true),
    body: JSON.stringify({
      merchantCartToken: cart.merchantCartToken,
      shippingAreaCode: "",
      items: cart.lines.map((line) => ({ cartItemSn: line.cartItemSn }))
    })
  })
  if (response.kind !== "ok") return response
  if (isChallenge(response.value.status, response.value.body)) return { kind: "paused", reason: BANDAI_PAUSE }
  if (response.value.status === 401) return { kind: "unauthorized", reason: EXPIRED_PAUSE }
  if (response.value.status === 429 || response.value.status >= 500) {
    return { kind: "retry", reason: `Checkout start returned HTTP ${response.value.status}. Retrying.` }
  }
  const checkoutSn = text(asRecord(safeJson(response.value.body))?.checkoutSn)
  if (!checkoutSn || response.value.status >= 400) {
    return { kind: "failed", reason: `Premium Bandai did not start checkout (HTTP ${response.value.status}).` }
  }
  return { kind: "ok", value: { checkoutSn, lines: cart.lines } }
}

async function clearLines(ctx: StoreRunContext, jar: CookieJar, lines: CartReading["lines"], page: string): Promise<void> {
  const ids = lines.map((line) => line.cartItemSn).filter(Boolean)
  if (!ids.length) return
  const params = new URLSearchParams()
  for (const id of ids) params.append("cartLineItemSns", id)
  await store(ctx, jar, {
    method: "DELETE",
    url: `${ORIGIN}/api/cart/removeCartLineItems?${params.toString()}`,
    headers: apiHeaders(jar, page, true)
  })
}

async function store(ctx: StoreRunContext, jar: CookieJar, request: HttpRequest): Promise<Step<HttpResponse>> {
  let host = ""
  try {
    host = new URL(request.url).hostname
  } catch {
    return { kind: "failed", reason: "The Premium Bandai request URL is invalid." }
  }
  if (host !== "p-bandai.com") return { kind: "failed", reason: `Refusing to contact ${host}.` }
  const response = await ctx.http.request({ ...request, proxy: ctx.proxy, signal: ctx.signal })
  if (jar.absorb(response.headers)) {
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

function apiHeaders(jar: CookieJar, referer: string, write = false): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "accept-language": "en",
    "x-g1-area-code": "us",
    "x-requested-with": "XMLHttpRequest",
    origin: ORIGIN,
    referer,
    "user-agent": chromeUserAgent(),
    cookie: jar.header()
  }
  if (write) headers["content-type"] = "application/json"
  if (jar.csrf) headers["x-csrf-token"] = jar.csrf
  return headers
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

function text(value: unknown): string {
  if (typeof value === "string") return value.trim()
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return ""
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
