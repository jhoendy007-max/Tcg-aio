import type { HttpClient, HttpRequest, HttpResponse } from "./http"
import { proxyLabel } from "../shared/proxy"
import { storeName } from "../shared/stores"
import type { ProxyEndpoint, SessionCookies, Settings } from "../shared/types"
import type { StoreRunContext } from "../stores/module"
import { classifyTraffic } from "./traffic"

export { pageLooksLikeChallenge } from "./traffic"

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
  /** How long to leave the account window open when the store is showing a check. */
  holdMs?: number
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
const streaks = new WeakMap<StoreRunContext, number>()
const MONITOR_BACKOFF_CAP_MS = 2 * 60 * 1000
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
  if (response && classifyTraffic({ status, body: response.body, headers: response.headers }) === "queue") return false
  if (status === 403 || status === 412 || status === 435) return true
  return status === 429
}

/** An anonymous stock monitor: no store account and no checkout. It never touches a session or a browser. */
export function isAnonymousMonitor(ctx: Pick<StoreRunContext, "monitorOnly" | "account">): boolean {
  return ctx.monitorOnly === true && !ctx.account?.id
}

/** Blocked responses in a row for this run. Resets on the first response that is not a block. */
export function monitorBlockStreak(ctx: StoreRunContext): number {
  return streaks.get(ctx) ?? 0
}

/**
 * Wait before the next stock check after a block. With several proxies the monitor already moved
 * to another one, so the normal monitor delay is enough. With one proxy (or none) the wait doubles
 * per block in a row, never below the monitor delay and never above two minutes.
 */
export function monitorBlockWait(ctx: StoreRunContext, delayMs: number, random = Math.random()): number {
  const streak = monitorBlockStreak(ctx)
  const base = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 1000
  if (streak < 1 || proxyList(ctx).length > 1) return base
  const exp = Math.min(base * 2 ** Math.min(streak - 1, 10), MONITOR_BACKOFF_CAP_MS)
  const unit = Math.min(1, Math.max(0, random))
  const jittered = Math.round(exp * (0.85 + unit * 0.15))
  return Math.min(MONITOR_BACKOFF_CAP_MS, Math.max(base, jittered))
}

export function storeBlockedLine(store: StoreRunContext["task"]["store"], status: number): string {
  return `${storeName(store)} blocked this proxy (HTTP ${status}). Add more residential proxies to the group or try another one.`
}

export const SINGLE_PROXY_WARNING = "This group has 1 proxy. Stores block a single proxy quickly."

async function sendAnonymousMonitor(
  ctx: StoreRunContext,
  request: HttpRequest,
  options: { inner: HttpClient; blocked: (response: HttpResponse) => boolean }
): Promise<HttpResponse> {
  const list = proxyList(ctx)
  rememberStart(stickKey(ctx), list, ctx.proxy)
  const proxy = selectProxy(stickKey(ctx), list, Date.now()) ?? ctx.proxy
  if (proxy) ctx.proxy = proxy
  const response = await options.inner.request({ ...request, proxy, signal: ctx.signal })
  const kind = classifyTraffic(response)
  const blocked = options.blocked(response) && (kind === "rate_limit" || kind === "hard_block" || kind === "challenge")
  if (!blocked) {
    streaks.set(ctx, 0)
    return response
  }
  streaks.set(ctx, monitorBlockStreak(ctx) + 1)
  ctx.log("warn", proxy
    ? storeBlockedLine(ctx.task.store, response.status)
    : `${storeName(ctx.task.store)} blocked this connection (HTTP ${response.status}). This monitor has no proxy. Add residential proxies to its group.`)
  if (list.length > 1) {
    const next = advanceProxy(ctx, list, proxy)
    if (next) {
      ctx.proxy = next
      if (proxyKey(next) !== proxyKey(proxy)) ctx.log("info", `Rotating to proxy ${proxyLabel(next)} for the next stock check.`)
    }
  }
  return response
}

export async function sendWithRecovery(
  ctx: StoreRunContext,
  request: HttpRequest,
  options: { homeUrl: string; inner: HttpClient; blocked: (response: HttpResponse) => boolean }
): Promise<HttpResponse> {
  if (isAnonymousMonitor(ctx)) return sendAnonymousMonitor(ctx, request, options)
  const budget = blockRetryBudget(ctx.settings)
  const list = proxyList(ctx)
  rememberStart(stickKey(ctx), list, ctx.proxy)
  let response: HttpResponse | undefined
  for (let attempt = 1; attempt <= budget; attempt += 1) {
    const proxy = selectProxy(stickKey(ctx), list, Date.now()) ?? ctx.proxy
    if (proxy) ctx.proxy = proxy
    response = await options.inner.request({ ...request, proxy, signal: ctx.signal })
    const kind = classifyTraffic(response)
    const blocked = options.blocked(response) && (kind === "rate_limit" || kind === "hard_block")
    if (!blocked) {
      if (kind === "challenge") {
        ctx.log("warn", "The store is showing a challenge. A person can solve it in the account browser. TCGAIO does not solve challenges.")
      }
      return response
    }
    if (attempt === budget) {
      ctx.log("warn", `Pausing after ${budget} blocked ${budget === 1 ? "attempt" : "attempts"}.`)
      return response
    }
    const wait = backoffMs(attempt, ctx.module?.blockBackoffMs ?? ctx.settings.monitorDelayMs)
    if (kind === "rate_limit") {
      ctx.log("warn", `HTTP 429. Waiting ${formatWait(wait)} on the same connection, then retrying.`)
      await ctx.sleep(wait)
      continue
    }
    const locked = Boolean(ctx.account.id)
    const next = locked ? proxy : advanceProxy(ctx, list, proxy)
    ctx.log("warn", `${blockLog(response.status, proxy, next, locked)} Waiting ${formatWait(wait)} before reloading the store session.`)
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

function blockLog(status: number, current: ProxyEndpoint | undefined, next: ProxyEndpoint | undefined, locked = false): string {
  const where = current ? `proxy ${proxyLabel(current)}` : "a direct connection"
  if (locked) return `HTTP ${status} through ${where}. Keeping this account's sticky proxy and reloading its browser profile.`
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

function formatWait(ms: number): string {
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
  return `${ms}ms`
}
