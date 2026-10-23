import type { HttpClient } from "./http"
import { chromeUserAgent } from "./chrome-ua"
import { BENCH_SKUS, BENCH_TIMEOUT_MS, isTimeout, probeMonitor } from "./bench"
import { proxyLabel } from "../shared/proxy"
import { storeName } from "../shared/stores"
import type { MonitorProbeResult, ProxyEndpoint, ProxySiteResult, StoreId } from "../shared/types"

const CHALLENGE_RE = /captcha|are-you-human|verify you are human|access denied|just a moment|px-captcha|datadome|perimeterx|request unsuccessful|robot check|blocked/i

/** Works / blocked / timeout for one website reply. A redirect to another page on the site is fine; one to a challenge is not. */
export function readSite(status: number, location: string, body: string): { verdict: ProxySiteResult["verdict"]; detail: string } {
  if (status === 403 || status === 412 || status === 429 || status === 435 || status === 503) return { verdict: "blocked", detail: `Blocked · HTTP ${status}` }
  if (status >= 300 && status < 400) {
    return CHALLENGE_RE.test(location) ? { verdict: "blocked", detail: `Blocked · captcha redirect (HTTP ${status})` } : { verdict: "works", detail: `Works · redirect (HTTP ${status})` }
  }
  if (CHALLENGE_RE.test(body.slice(0, 8000))) return { verdict: "blocked", detail: `Blocked · captcha page (HTTP ${status})` }
  if (status >= 200 && status < 300) return { verdict: "works", detail: `Works · HTTP ${status}` }
  return { verdict: "error", detail: `HTTP ${status}` }
}

async function pool<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      out[index] = await run(items[index])
    }
  }))
  return out
}

/** One GET of the chosen website through each proxy, with the response time in ms. */
export function testProxiesOnSite(http: HttpClient, proxies: ProxyEndpoint[], url: string): Promise<ProxySiteResult[]> {
  return pool(proxies, 5, async (proxy) => {
    const base = { proxyId: proxy.id, label: proxyLabel(proxy), url }
    const started = Date.now()
    try {
      const response = await http.request({
        method: "GET",
        url,
        proxy,
        redirect: "manual",
        timeoutMs: BENCH_TIMEOUT_MS,
        headers: { accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9", "user-agent": chromeUserAgent() }
      })
      const ms = Math.round(response.timing?.totalMs || Date.now() - started)
      const location = String(response.headers?.location ?? "")
      return { ...base, status: response.status, ms, ...readSite(response.status, location, response.body) }
    } catch (err) {
      if (isTimeout(err)) return { ...base, status: null, ms: null, verdict: "timeout" as const, detail: `Timeout · no answer in ${BENCH_TIMEOUT_MS / 1000}s` }
      return { ...base, status: null, ms: null, verdict: "error" as const, detail: err instanceof Error ? err.message.slice(0, 160) : "The request failed." }
    }
  })
}

/** The deeper test: the store's monitor request on a real product, read by its stock parser, through each proxy. */
export function testMonitorOnProxies(http: HttpClient, proxies: ProxyEndpoint[], store: StoreId, sku = BENCH_SKUS[store]): Promise<MonitorProbeResult[]> {
  return pool(proxies, 3, async (proxy) => ({
    proxyId: proxy.id,
    label: proxyLabel(proxy),
    store,
    storeName: storeName(store),
    ...(await probeMonitor(http, store, sku, proxy))
  }))
}
