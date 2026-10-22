import { accountPartition } from "../shared/consistency"
import type { ProxyEndpoint } from "../shared/types"
import type { HttpRequest, HttpResponse, RequestTiming } from "./http"

const SKIP_REQUEST_HEADERS = new Set([
  "cookie",
  "content-length",
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "cookie2"
])

export interface CookieSnap {
  name: string
  value: string
}

export interface StoredCookie extends CookieSnap {
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  hostOnly?: boolean
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict"
  expirationDate?: number
}

export interface CookieWrite {
  name: string
  value: string
  domain?: string
  path?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: "no_restriction" | "lax" | "strict"
  expirationDate?: number
}

export interface ChromiumPlan {
  partition: string
  headers: Record<string, string>
  cookies: CookieSnap[]
  redirect: "follow" | "manual"
}

/** In-memory partition for a monitor that has no account. One partition per proxy. */
export function monitorPartition(proxy?: Pick<ProxyEndpoint, "host" | "port" | "username">): string {
  if (!proxy) return "monitor-direct"
  return `monitor-${fnv32(`${proxy.host}:${proxy.port}:${proxy.username ?? ""}`)}`
}

/**
 * Account tasks stay on persist:account-${id}. Anything else uses the partition
 * already chosen, or an isolated monitor partition for that proxy.
 */
export function partitionForRequest(input: Pick<HttpRequest, "partition" | "proxy">, accountId?: string): string {
  if (accountId) return accountPartition(accountId)
  if (input.partition) return input.partition
  return monitorPartition(input.proxy)
}

export function parseCookieHeader(header: string | undefined): CookieSnap[] {
  if (!header) return []
  const pairs: CookieSnap[] = []
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name) continue
    pairs.push({ name, value })
  }
  return pairs
}

/**
 * Jar cookies are written into the session before the request. Chromium sends
 * the session jar and ignores a Cookie header while that is on. An existing
 * cookie keeps its domain, path, and httpOnly flag. Only the value changes.
 */
export function cookieWrites(url: string, jar: CookieSnap[], existing: StoredCookie[]): CookieWrite[] {
  const secure = url.startsWith("https://")
  const writes: CookieWrite[] = []
  for (const pair of jar) {
    const matches = existing.filter((cookie) => cookie.name === pair.name)
    if (!matches.length) {
      writes.push({ name: pair.name, value: pair.value, path: "/", secure })
      continue
    }
    for (const match of matches) {
      if (match.value === pair.value) continue
      const sameSite = match.sameSite === "lax" || match.sameSite === "strict" || match.sameSite === "no_restriction" ? match.sameSite : undefined
      writes.push({
        name: pair.name,
        value: pair.value,
        domain: match.hostOnly ? undefined : match.domain,
        path: match.path || "/",
        secure: match.secure,
        httpOnly: match.httpOnly,
        sameSite,
        expirationDate: match.expirationDate
      })
    }
  }
  return writes
}

/** Cookies whose value changed during the request. Used when a redirect hides set-cookie. */
export function cookieDiff(before: CookieSnap[], after: CookieSnap[]): string[] {
  const prior = new Map<string, string>()
  for (const cookie of before) prior.set(cookie.name, cookie.value)
  const lines: string[] = []
  const seen = new Set<string>()
  for (const cookie of after) {
    if (seen.has(cookie.name)) continue
    seen.add(cookie.name)
    if (prior.get(cookie.name) !== cookie.value) lines.push(`${cookie.name}=${cookie.value}`)
  }
  return lines
}

/** Destination schemes, both through an HTTP proxy. `https://host` would speak TLS to the proxy. */
export function chromiumProxyRules(proxy: { host: string; port: number }): string {
  return `http=${proxy.host}:${proxy.port};https=${proxy.host}:${proxy.port}`
}

/**
 * Electron 25+ defaults referrerPolicy to strict-origin-when-cross-origin.
 * A full Referer to another host (www.target.com → redsky.target.com) is then
 * cancelled inside Chromium as net::ERR_BLOCKED_BY_CLIENT and never sent.
 */
export function chromiumCallOptions(redirect: "follow" | "manual"): {
  redirect: "follow" | "manual"
  referrerPolicy: "unsafe-url"
  useSessionCookies: true
} {
  return { redirect, referrerPolicy: "unsafe-url", useSessionCookies: true }
}

export interface ProxyLoginChallenge {
  isProxy?: boolean
  host?: string
  port?: number
}

/** Proxy auth is the proxy flag or a host:port match. An empty login callback cancels the request. */
export function classifyProxyLogin(
  auth: ProxyLoginChallenge,
  proxy?: { host: string; port: number; username?: string }
): "credentials" | "missing" | "store" {
  const sameProxy = Boolean(
    proxy &&
    auth.host &&
    auth.port !== undefined &&
    auth.host.toLowerCase() === proxy.host.toLowerCase() &&
    Number(auth.port) === Number(proxy.port)
  )
  if (!auth.isProxy && !sameProxy) return "store"
  return proxy?.username ? "credentials" : "missing"
}

export const STOCK_CHECK_TIMEOUT = "The stock check timed out. The proxy or the store did not answer."

/** Chromium net errors become one plain sentence. A user stop stays a stop. */
export function plainNetworkError(error: unknown): Error {
  if (error instanceof Error && (error.name === "AbortError" || error.message === "The task was stopped.")) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/ERR_BLOCKED_BY_CLIENT/i.test(message)) return new Error("Request blocked inside the app.")
  if (/ERR_PROXY|ERR_TUNNEL|PROXY_CONNECTION_FAILED|PROXY_AUTH/i.test(message)) return new Error("Proxy failed.")
  if (message === STOCK_CHECK_TIMEOUT || /ETIMEDOUT|ERR_TIMED_OUT|\btimed out\b/i.test(message)) return new Error(STOCK_CHECK_TIMEOUT)
  if (/ECONNRESET|ECONNREFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_REFUSED|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/i.test(message)) {
    return new Error("Proxy failed. The connection closed before the store answered.")
  }
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK_CHANGED/i.test(message)) {
    return new Error("Proxy failed. The address could not be reached.")
  }
  if (/net::/i.test(message)) return new Error("Proxy failed.")
  return error instanceof Error ? error : new Error(message)
}

export function planChromiumCall(input: HttpRequest): ChromiumPlan {
  const headers: Record<string, string> = {}
  let cookie: string | undefined
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const key = name.toLowerCase()
    if (key === "cookie") {
      cookie = cookie ? `${cookie}; ${value}` : value
      continue
    }
    if (SKIP_REQUEST_HEADERS.has(key)) continue
    headers[name] = value
  }
  return {
    partition: input.partition ? input.partition : monitorPartition(input.proxy),
    headers,
    cookies: parseCookieHeader(cookie),
    redirect: input.redirect === "manual" ? "manual" : "follow"
  }
}

/**
 * Chromium decodes the body before we see it, so content-encoding and
 * content-length from the wire would describe a different payload.
 * set-cookie is kept as one string or an array, which is what the store jars read.
 */
export function toHttpHeaders(
  headers: Record<string, string | string[] | undefined>,
  extraSetCookies: string[] = []
): HttpResponse["headers"] {
  const out: Record<string, string | string[]> = {}
  for (const [raw, value] of Object.entries(headers)) {
    if (value === undefined) continue
    const key = raw.toLowerCase()
    if (key === "content-encoding" || key === "content-length") continue
    if (key === "set-cookie") {
      const list = Array.isArray(value) ? value : [value]
      const prev = out[key]
      const merged = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), ...list]
      out[key] = merged.length === 1 ? merged[0] : merged
      continue
    }
    if (Array.isArray(value)) out[key] = value.length === 1 ? value[0] : value
    else out[key] = value
  }
  const merged = mergeSetCookies(out["set-cookie"], extraSetCookies)
  if (merged.length === 1) out["set-cookie"] = merged[0]
  else if (merged.length > 1) out["set-cookie"] = merged
  return out
}

function mergeSetCookies(current: string | string[] | undefined, extra: string[]): string[] {
  const list = Array.isArray(current) ? [...current] : current ? [current] : []
  const names = new Set(list.map(cookieName))
  for (const line of extra) {
    const name = cookieName(line)
    if (!name || names.has(name)) continue
    names.add(name)
    list.push(line)
  }
  return list
}

function cookieName(line: string): string {
  const pair = line.split(";")[0] ?? ""
  const eq = pair.indexOf("=")
  return eq > 0 ? pair.slice(0, eq).trim() : ""
}

/** DNS and connect are not reported by Chromium's network stack. Total time still is. */
export function chromiumTiming(started: number, headerAt: number, finished: number): RequestTiming {
  const totalMs = Math.max(0, Math.round(finished - started))
  const ttfbMs = Math.max(0, Math.round(headerAt - started))
  return {
    dnsMs: 0,
    connectMs: 0,
    ttfbMs: Math.min(ttfbMs, totalMs),
    totalMs
  }
}

function fnv32(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}
