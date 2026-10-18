import { AsyncLocalStorage } from "node:async_hooks"
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns"
import { subscribe as subscribeDiagnostic } from "node:diagnostics_channel"
import { performance } from "node:perf_hooks"
import { Agent, ProxyAgent, request as undiciRaw, type Dispatcher } from "undici"
import { proxyToUrl } from "../shared/proxy"
import type { ProxyEndpoint } from "../shared/types"

export interface RequestTiming {
  dnsMs: number
  connectMs: number
  ttfbMs: number
  totalMs: number
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  url: string
  headers?: Record<string, string>
  body?: string
  proxy?: ProxyEndpoint
  signal?: AbortSignal
  redirect?: "follow" | "manual"
  timeoutMs?: number
  /**
   * Chromium partition for the desktop store client. Account tasks set
   * persist:account-${id}. A blank value selects an in-memory partition for the proxy.
   * Undici ignores this field.
   */
  partition?: string
}

export interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
  timing?: RequestTiming
}

export interface HttpClient {
  request(input: HttpRequest): Promise<HttpResponse>
}

interface TimingBag {
  dnsMs: number
  connectStart: number
  connectMs: number
  sentAt: number
  ttfbMs: number
}

const timings = new AsyncLocalStorage<TimingBag>()
const agents = new Map<string, Dispatcher>()
const h1Agents = new Map<string, Dispatcher>()
let hooked = false

function hookTiming(): void {
  if (hooked) return
  hooked = true
  subscribeDiagnostic("undici:client:beforeConnect", () => {
    const bag = timings.getStore()
    if (bag && bag.connectStart === 0) bag.connectStart = performance.now()
  })
  subscribeDiagnostic("undici:client:connected", () => {
    const bag = timings.getStore()
    if (bag && bag.connectStart) bag.connectMs = performance.now() - bag.connectStart
  })
  subscribeDiagnostic("undici:request:create", () => {
    const bag = timings.getStore()
    if (bag) bag.sentAt = performance.now()
  })
  subscribeDiagnostic("undici:request:headers", () => {
    const bag = timings.getStore()
    if (bag && bag.sentAt) bag.ttfbMs = performance.now() - bag.sentAt
  })
}

function timedLookup(hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  const bag = timings.getStore()
  const start = performance.now()
  dnsLookup(hostname, options, (err, address, family) => {
    if (bag) bag.dnsMs += performance.now() - start
    if (Array.isArray(address)) callback(err, address)
    else callback(err, address, family)
  })
}

const pool = {
  allowH2: true,
  connections: 8,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: { lookup: timedLookup }
} as const

function directAgent(): Dispatcher {
  let agent = agents.get("direct")
  if (!agent) {
    agent = new Agent(pool)
    agents.set("direct", agent)
  }
  return agent
}

function h1AgentFor(proxy?: ProxyEndpoint): Dispatcher {
  const key = proxy ? `h1:${proxyToUrl(proxy)}` : "h1:direct"
  let agent = h1Agents.get(key)
  if (!agent) {
    const options = { ...pool, allowH2: false as const }
    agent = proxy
      ? new ProxyAgent({ ...options, uri: proxyToUrl(proxy), requestTls: { lookup: timedLookup }, proxyTls: { lookup: timedLookup } })
      : new Agent(options)
    h1Agents.set(key, agent)
  }
  return agent
}

function agentFor(proxy?: ProxyEndpoint): Dispatcher {
  if (!proxy) return directAgent()
  const key = proxyToUrl(proxy)
  let agent = agents.get(key)
  if (!agent) {
    agent = new ProxyAgent({
      ...pool,
      uri: key,
      requestTls: { lookup: timedLookup },
      proxyTls: { lookup: timedLookup }
    })
    agents.set(key, agent)
  }
  return agent
}

export async function undiciRequest(input: HttpRequest): Promise<HttpResponse> {
  hookTiming()
  const bag: TimingBag = { dnsMs: 0, connectStart: 0, connectMs: 0, sentAt: 0, ttfbMs: 0 }
  const started = performance.now()
  return timings.run(bag, async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 25000)
    const onAbort = () => controller.abort()
    input.signal?.addEventListener("abort", onAbort)
    try {
      try {
        return await readResponse(input, agentFor(input.proxy), controller.signal, bag, started)
      } catch (err) {
        const message = err instanceof Error ? err.message : ""
        const retry = !input.signal?.aborted && /NGHTTP2|ERR_HTTP2|HTTP\/2|HEADERS_TIMEOUT|BODY_TIMEOUT|Headers Timeout|Body Timeout/i.test(message)
        if (!retry) throw err
        bag.dnsMs = 0
        bag.connectStart = 0
        bag.connectMs = 0
        bag.sentAt = 0
        bag.ttfbMs = 0
        return await readResponse(input, h1AgentFor(input.proxy), controller.signal, bag, performance.now())
      }
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener("abort", onAbort)
    }
  })
}

async function readResponse(input: HttpRequest, dispatcher: Dispatcher, signal: AbortSignal, bag: TimingBag, started: number): Promise<HttpResponse> {
  const res = await undiciRaw(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    maxRedirections: input.redirect === "manual" ? 0 : 5,
    headersTimeout: 8_000,
    bodyTimeout: 12_000,
    signal,
    dispatcher
  })
  if (!bag.ttfbMs) bag.ttfbMs = performance.now() - started
  const body = await res.body.text()
  const headers: Record<string, string | string[] | undefined> = {}
  for (const [key, value] of Object.entries(res.headers)) {
    if (value !== undefined) headers[key] = value
  }
  return {
    status: res.statusCode,
    headers,
    body,
    timing: {
      dnsMs: Math.round(bag.dnsMs),
      connectMs: Math.round(bag.connectMs),
      ttfbMs: Math.round(bag.ttfbMs),
      totalMs: Math.round(performance.now() - started)
    }
  }
}

export const defaultHttp: HttpClient = { request: undiciRequest }

/** Open the keep-alive pool to each monitor host. Read-only. Failures are ignored. */
export async function warmMonitorHosts(http: HttpClient, urls: string[], proxy?: ProxyEndpoint): Promise<void> {
  await Promise.all(urls.map((url) => http.request({ method: "GET", url, proxy, timeoutMs: 8000 }).catch(() => undefined)))
}
