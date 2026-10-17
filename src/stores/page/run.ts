import { holdMonitorOnly, monitorKey, noteWatch, sharedValue } from "../../engine/monitor"
import { productImage } from "../../shared/image"
import { note } from "../../engine/test-mode"
import type { HttpRequest, HttpResponse } from "../../engine/http"
import { retryWait, type StoreModule, type StoreRunContext, type StoreRunResult } from "../module"
import { checkoutCopy, checkoutLang } from "./copy"
import { checkoutFromPage } from "./flow"
import { PageCookies } from "./jar"
import {
  isLoginWall,
  isPageChallenge,
  parsePageTarget,
  readPageOffer,
  type PageReading,
  type PageSpec
} from "./parse"

export { pageHandoff } from "./copy"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

export function pageChallengePause(name: string, language?: string): string {
  return checkoutCopy(checkoutLang(language)).challenge(name)
}

export function pageSessionPause(name: string, host: string): string {
  return `Paste a signed-in ${name} session (the ${host} cookie header) or use Sign in on the Session Keeper page. TCGAIO does not solve challenges.`
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

interface OfferHit {
  reading: PageReading
  html: string
}

export function createPageModule(spec: PageSpec): StoreModule {
  return {
    id: spec.id,
    displayName: spec.name,
    skuHint: spec.skuHint,
    implemented: true,
    run: (ctx) => runPage(ctx, spec)
  }
}

async function runPage(ctx: StoreRunContext, spec: PageSpec): Promise<StoreRunResult> {
  const target = parsePageTarget(spec, ctx.task.sku)
  if (!target) return fail(`Enter a ${spec.name} product URL or product id.`)
  if (ctx.profile.shipping.country !== "US") return fail("v1 places US ship-to-home orders only.")
  if (ctx.account.store !== spec.id) return fail(`Choose a ${spec.name} account.`)
  if (!ctx.account.session?.cookie && !ctx.account.session?.accessToken) return pause(pageSessionPause(spec.name, spec.host))

  const jar = new PageCookies()
  jar.load(ctx.account.session)
  const challenge = pageChallengePause(spec.name, ctx.settings.language)
  ctx.phase("monitoring")
  ctx.log("info", `Watching ${target.sku} on ${spec.name}.`)
  note(ctx, "session", "pass", `Saved ${spec.name} session loaded.`)
  let waits = 0

  while (!ctx.signal.aborted) {
    const stock = await readOffer(ctx, spec, jar, target.sku, target.url, challenge)
    if (stock.kind === "retry") {
      ctx.detail(stock.reason)
      ctx.log("warn", stock.reason)
      await ctx.sleep(retryWait(ctx))
      continue
    }
    if (stock.kind !== "ok") return asResult(stock)
    const { reading, html } = stock.value
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
    const bought = await checkoutFromPage(ctx, spec, target.url, html, reading.title || target.sku, target.sku, reading.price, {
      request: async (method, url, referer, body) => {
        const result = await checkoutRequest(ctx, spec, jar, method, url, referer, body)
        if (result.kind === "ok") return result
        return { kind: result.kind === "paused" ? "paused" : "failed", reason: result.reason }
      }
    })
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

async function readOffer(
  ctx: StoreRunContext,
  spec: PageSpec,
  jar: PageCookies,
  sku: string,
  page: string,
  challenge: string
): Promise<Step<OfferHit>> {
  const response = await sharedValue(ctx, monitorKey(spec.id, sku, "page", ctx.proxy), () =>
    store(ctx, spec, jar, { method: "GET", url: page, headers: pageHeaders(jar, spec.home) })
  )
  if (response.kind !== "ok") return response
  if (isPageChallenge(response.value.status, response.value.body)) return { kind: "paused", reason: challenge }
  if (response.value.status === 401 || isLoginWall(response.value.body)) {
    return { kind: "paused", reason: checkoutCopy(checkoutLang(ctx.settings.language)).notSignedIn(spec.name) }
  }
  if (response.value.status === 429 || response.value.status >= 500) {
    return { kind: "retry", reason: `Monitor request returned HTTP ${response.value.status}. Retrying.` }
  }
  const reading = readPageOffer(spec, response.value.body, sku)
  if (response.value.status === 404) {
    return {
      kind: "ok",
      value: {
        html: response.value.body,
        reading: { ...reading, inStock: false, status: "UNAVAILABLE", reason: `${reading.title || sku} product page was not found.` }
      }
    }
  }
  if (response.value.status >= 400) {
    return { kind: "retry", reason: `Monitor returned HTTP ${response.value.status} without a product page.` }
  }
  reading.imageUrl = productImage(response.value.body) || undefined
  noteWatch(ctx, { ...reading, url: page })
  return { kind: "ok", value: { reading, html: response.value.body } }
}

async function checkoutRequest(
  ctx: StoreRunContext,
  spec: PageSpec,
  jar: PageCookies,
  method: "GET" | "POST",
  url: string,
  referer: string,
  body?: string
): Promise<Step<HttpResponse>> {
  const headers = pageHeaders(jar, referer)
  if (method === "POST") {
    headers["content-type"] = "application/x-www-form-urlencoded"
    headers.origin = `https://${spec.host}`
  }
  return store(ctx, spec, jar, { method, url, headers, body, redirect: "manual" })
}

async function store(ctx: StoreRunContext, spec: PageSpec, jar: PageCookies, request: HttpRequest): Promise<Step<HttpResponse>> {
  if (request.method !== "GET" && request.method !== "POST") return { kind: "failed", reason: `${spec.name} checkout is not sent from TCGAIO.` }
  let host = ""
  try {
    host = new URL(request.url).hostname.toLowerCase()
  } catch {
    return { kind: "failed", reason: `The ${spec.name} request URL is invalid.` }
  }
  if (host !== spec.host || host.includes("ecom-api")) return { kind: "failed", reason: `Refusing to contact ${host}.` }
  const response = await ctx.http.request({ ...request, proxy: ctx.proxy, signal: ctx.signal })
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

function pageHeaders(jar: PageCookies, referer: string): Record<string, string> {
  return {
    accept: "text/html,application/xhtml+xml,application/json",
    "accept-language": "en-US,en;q=0.9",
    referer,
    "user-agent": USER_AGENT,
    cookie: jar.header()
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
  if (step.reason === "Stopped") return { outcome: "stopped", reason: "Stopped" }
  return { outcome: "failed", reason: step.reason }
}
