import type { HttpClient, HttpRequest, HttpResponse } from "./http"
import { proxyLabel } from "../shared/proxy"
import type { ProxyEndpoint, SessionCookies, Settings } from "../shared/types"
import type { StoreRunContext } from "../stores/module"

const COOLDOWN_MS = 10 * 60 * 1000

export interface SessionRefreshRequest {
  accountId: string
  store: StoreRunContext["task"]["store"]
  homeUrl: string
  proxy?: ProxyEndpoint
  /** Cookies already saved for this account. They are written into the browser before the reload. */
  existing?: SessionCookies
  signal: AbortSignal
  onChallenge: (message: string) => void
  /** Read a code from the user's mailbox. The digits stay in the browser fill. */
  lookupCode?: () => Promise<string | null>
  onMailFilled?: () => void
}

export interface SessionRefreshResult {
  cookies: SessionCookies
  challenged: boolean
}

export type SessionRefresher = (input: SessionRefreshRequest) => Promise<SessionRefreshResult>

interface StickyState {
  current?: string
  unhealthy: Map<string, number>
}

const sticky = new Map<string, StickyState>()
const binders = new WeakMap<StoreRunContext, (cookies: SessionCookies) => void>()

export function resetBlockRecoveryState(): void {
  sticky.clear()
}

export function attachSession(ctx: StoreRunContext, apply: (cookies: SessionCookies) => void): void {
  binders.set(ctx, apply)
}

export function blockRetryBudget(settings: Settings): number {
  const value = Math.round(Number(settings.blockRetries))
  if (!Number.isInteger(value) || value < 1 || value > 8) return 3
  return value
}

/** Exponential delay with jitter. `random` is 0..1. The result stays between half and all of the capped delay. */
export function backoffMs(attempt: number, baseMs: number, random = Math.random()): number {
  const safeBase = Number.isFinite(baseMs) && baseMs > 0 ? baseMs : 1000
  const exp = Math.min(safeBase * 2 ** Math.min(Math.max(attempt, 1) - 1, 4), 60_000)
  const unit = Math.min(1, Math.max(0, random))
  return Math.max(500, Math.round(exp * (0.5 + unit * 0.5)))
}

export function isBlockStatus(status: number, response?: Pick<HttpResponse, "body" | "headers">): boolean {
  if (status === 403 || status === 412 || status === 435) return true
  if (status !== 429 || !response) return status === 429
  return !isProductQueue(response)
}

export function pageLooksLikeChallenge(text: string): boolean {
  const lower = text.toLowerCase()
  const markers = [
    "captcha",
    "access denied",
    "press and hold",
    "press-and-hold",
    "verify you are human",
    "please verify you are a human",
    "robot check",
    "robot or human",
    "just a moment",
    "challenge-platform",
    "attention required",
    "pardon our interruption"
  ]
  return markers.some((marker) => lower.includes(marker))
}

export async function sendWithRecovery(
  ctx: StoreRunContext,
  request: HttpRequest,
  options: { homeUrl: string; inner: HttpClient; blocked: (response: HttpResponse) => boolean }
): Promise<HttpResponse> {
  const budget = blockRetryBudget(ctx.settings)
  const list = proxyList(ctx)
  rememberStart(stickKey(ctx), list, ctx.proxy)
  let response: HttpResponse | undefined
  for (let attempt = 1; attempt <= budget; attempt += 1) {
    const proxy = selectProxy(stickKey(ctx), list, Date.now()) ?? ctx.proxy
    if (proxy) ctx.proxy = proxy
    response = await options.inner.request({ ...request, proxy, signal: ctx.signal })
    if (!options.blocked(response) || attempt === budget) {
      if (options.blocked(response) && attempt === budget) {
        ctx.log("warn", `Pausing after ${budget} blocked ${budget === 1 ? "attempt" : "attempts"}.`)
      }
      return response
    }
    const wait = backoffMs(attempt, ctx.module?.blockBackoffMs ?? ctx.settings.monitorDelayMs)
    const next = advanceProxy(ctx, list, proxy)
    ctx.log("warn", `${blockLog(response.status, proxy, next)} Waiting ${formatWait(wait)} before reloading the store session.`)
    await ctx.sleep(wait)
    await reloadSession(ctx, request, options.homeUrl, next ?? proxy)
  }
  if (!response) throw new Error("Block recovery did not send a request.")
  return response
}

function stickKey(ctx: StoreRunContext): string {
  return `${ctx.task.store}:${ctx.account.id}`
}

function proxyList(ctx: StoreRunContext): ProxyEndpoint[] {
  if (ctx.proxies?.length) return ctx.proxies
  if (ctx.proxy) return [ctx.proxy]
  return []
}

export function proxyKey(proxy?: ProxyEndpoint): string {
  if (!proxy) return "direct"
  return `${proxy.host}:${proxy.port}:${proxy.username ?? ""}`
}

export function selectProxy(accountKey: string, list: ProxyEndpoint[], now: number): ProxyEndpoint | undefined {
  if (!list.length) return undefined
  const state = ensure(accountKey)
  const healthy = (proxy: ProxyEndpoint) => (state.unhealthy.get(proxyKey(proxy)) ?? 0) <= now
  if (state.current) {
    const kept = list.find((proxy) => proxyKey(proxy) === state.current && healthy(proxy))
    if (kept) return kept
  }
  const start = state.current ? list.findIndex((proxy) => proxyKey(proxy) === state.current) : -1
  for (let step = 1; step <= list.length; step += 1) {
    const candidate = list[(start + step) % list.length]
    if (healthy(candidate)) {
      state.current = proxyKey(candidate)
      return candidate
    }
  }
  const soonest = [...list].sort((a, b) => (state.unhealthy.get(proxyKey(a)) ?? 0) - (state.unhealthy.get(proxyKey(b)) ?? 0))[0]
  state.current = proxyKey(soonest)
  return soonest
}

function rememberStart(accountKey: string, list: ProxyEndpoint[], preferred?: ProxyEndpoint): void {
  if (!preferred || !list.length) return
  const state = ensure(accountKey)
  if (state.current) return
  if (list.some((proxy) => proxyKey(proxy) === proxyKey(preferred))) state.current = proxyKey(preferred)
}

function advanceProxy(ctx: StoreRunContext, list: ProxyEndpoint[], current: ProxyEndpoint | undefined): ProxyEndpoint | undefined {
  if (!list.length) return undefined
  const state = ensure(stickKey(ctx))
  const failed = current ?? list.find((proxy) => proxyKey(proxy) === state.current) ?? list[0]
  state.unhealthy.set(proxyKey(failed), Date.now() + COOLDOWN_MS)
  state.current = proxyKey(failed)
  return selectProxy(stickKey(ctx), list, Date.now())
}

function ensure(accountKey: string): StickyState {
  let state = sticky.get(accountKey)
  if (!state) {
    state = { unhealthy: new Map() }
    sticky.set(accountKey, state)
  }
  return state
}

function blockLog(status: number, current: ProxyEndpoint | undefined, next: ProxyEndpoint | undefined): string {
  const where = current ? `proxy ${proxyLabel(current)}` : "a direct connection"
  const moved = Boolean(next && (!current || proxyKey(next) !== proxyKey(current)))
  const action = moved && next ? `Rotating to proxy ${proxyLabel(next)}.` : "No other proxy is in the group."
  return `HTTP ${status} through ${where}. ${action}`
}

async function reloadSession(ctx: StoreRunContext, request: HttpRequest, homeUrl: string, proxy: ProxyEndpoint | undefined): Promise<void> {
  if (!ctx.refreshSession) {
    ctx.log("info", "No embedded browser is attached. Retrying with the saved session.")
    return
  }
  try {
    const refreshed = await ctx.refreshSession({ homeUrl, proxy, signal: ctx.signal })
    binders.get(ctx)?.(refreshed.cookies)
    await ctx.onSession(refreshed.cookies)
    const header = refreshed.cookies.cookie
    if (header) request.headers = { ...request.headers, cookie: header }
    if (refreshed.cookies.accessToken && refreshed.cookies.accessToken !== "session" && request.headers?.authorization) {
      request.headers = { ...request.headers, authorization: `Bearer ${refreshed.cookies.accessToken}` }
    }
    ctx.log(refreshed.challenged ? "warn" : "info", refreshed.challenged
      ? "The store is still showing a challenge after the browser reload."
      : "Copied the cookies the store set in the account browser.")
  } catch (err) {
    if (ctx.signal.aborted) throw err
    const message = err instanceof Error ? err.message : String(err)
    ctx.log("warn", `The account browser could not reload the store (${message}). Retrying with the saved session.`)
  }
}

function isProductQueue(response: Pick<HttpResponse, "body" | "headers">): boolean {
  const wait = headerValue(response.headers, "a2ctransactionwait") || headerValue(response.headers, "a2ctransactioncode")
  if (wait) return true
  const text = response.body.slice(0, 2000)
  return text.includes("CONSTRAINED_ITEM") || text.includes("PLEASE_WAIT")
}

function headerValue(headers: HttpResponse["headers"], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

function formatWait(ms: number): string {
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}
