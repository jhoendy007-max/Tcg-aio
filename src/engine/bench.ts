import { percentile } from "./monitor"
import { STORE_GAP_MS } from "./polite"
import type { HttpClient, HttpResponse } from "./http"
import { defaultHttp, warmMonitorHosts } from "./http"
import { offersUrl, parseAsin } from "../stores/amazon/parse"
import { parseSku as parseBandai, productApiUrl as bandaiProduct } from "../stores/bandai/parse"
import { monitorUrl, parseSku as parseBestBuy } from "../stores/bestbuy/parse"
import { parseSku as parseCrunchy, productApiUrl as crunchyProduct } from "../stores/crunchyroll/parse"
import { parseSku as parsePokemon, searchUrl } from "../stores/pokemon-center/parse"
import { parseTcin } from "../shared/tcin"
import { parseItemId } from "../stores/walmart/parse"
import { STORE_IDS, type ProxyEndpoint, type ProxyGroup, type StoreId } from "../shared/types"

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

/** Public read-only monitor URLs. These match the stock checks, not cart or checkout. */
export const BENCH_SKUS: Record<StoreId, string> = {
  target: "88897904",
  walmart: "13816151308",
  bestbuy: "6606082",
  "pokemon-center": "699-85207",
  amazon: "B0BSHF7WHW",
  crunchyroll: "810158836396",
  bandai: "N2716225001"
}

export interface BenchSample {
  store: StoreId
  ok: boolean
  status: number | null
  dnsMs: number
  connectMs: number
  ttfbMs: number
  totalMs: number
  proxy: string
  error?: string
}

export interface BenchStoreReport {
  store: StoreId
  proxy: string
  checks: number
  success: number
  successRate: number
  p50Ms: number
  p95Ms: number
  samples: BenchSample[]
}

/** The same read-only URL a monitor uses for this SKU. Null when the SKU does not parse. */
export function monitorReadUrl(store: StoreId, sku: string): string | null {
  if (store === "target") {
    const tcin = parseTcin(sku)
    if (!tcin) return null
    const url = new URL("https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1")
    url.searchParams.set("key", "9f36aeafbe60771e321a7cc95a78140772ab3e96")
    url.searchParams.set("tcins", tcin)
    url.searchParams.set("store_id", "1881")
    url.searchParams.set("pricing_store_id", "1881")
    url.searchParams.set("zip", "10001")
    url.searchParams.set("state", "NY")
    url.searchParams.set("channel", "WEB")
    url.searchParams.set("page", `/p/A-${tcin}`)
    return url.toString()
  }
  if (store === "walmart") {
    const itemId = parseItemId(sku)
    return itemId ? `https://www.walmart.com/ip/${itemId}` : null
  }
  if (store === "bestbuy") {
    const id = parseBestBuy(sku)
    return id ? monitorUrl(sku, id) : null
  }
  if (store === "pokemon-center") {
    const id = parsePokemon(sku)
    return id ? searchUrl(id) : null
  }
  if (store === "amazon") {
    const asin = parseAsin(sku)
    return asin ? offersUrl(asin) : null
  }
  if (store === "crunchyroll") {
    const id = parseCrunchy(sku)
    return id ? crunchyProduct(id) : null
  }
  const code = parseBandai(sku)
  return code ? bandaiProduct(code) : null
}

function headersFor(store: StoreId, url: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: store === "target" || store === "pokemon-center" || store === "crunchyroll" || store === "bandai" ? "application/json" : "text/html,application/json",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": USER_AGENT
  }
  if (store === "bandai") {
    headers["x-g1-area-code"] = "us"
    headers["x-requested-with"] = "XMLHttpRequest"
    headers.referer = "https://p-bandai.com/us/"
  }
  if (store === "target") headers.referer = "https://www.target.com/"
  if (store === "amazon") headers.referer = "https://www.amazon.com/"
  if (store === "crunchyroll") headers.referer = url
  return headers
}

/** A 2xx or 3xx body that is not a block page. */
export function monitorReadOk(status: number, body: string): boolean {
  if (status < 200 || status >= 400) return false
  const text = body.slice(0, 2000).toLowerCase()
  if (text.includes("access denied") || text.includes("just a moment") || text.includes("verify you are human") || text.includes("px-captcha")) return false
  return true
}

function proxyLabel(proxy?: ProxyEndpoint): string {
  return proxy ? `${proxy.host}:${proxy.port}` : "direct"
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * N read-only GETs per store through one proxy (or a direct connection).
 * Latency is the request time. The polite gap between checks is not included.
 */
export async function benchmarkStores(options: {
  n?: number
  proxy?: ProxyEndpoint
  http?: HttpClient
  stores?: StoreId[]
  gap?: boolean
}): Promise<BenchStoreReport[]> {
  const n = Math.max(1, Math.min(20, Math.round(options.n ?? 5)))
  const http = options.http ?? defaultHttp
  const stores = options.stores ?? [...STORE_IDS]
  const proxy = options.proxy
  const label = proxyLabel(proxy)
  const reports: BenchStoreReport[] = []
  for (const store of stores) {
    const url = monitorReadUrl(store, BENCH_SKUS[store])
    const samples: BenchSample[] = []
    for (let index = 0; index < n; index += 1) {
      if (options.gap !== false && index > 0) await sleep(STORE_GAP_MS[store])
      if (!url) {
        samples.push({ store, ok: false, status: null, dnsMs: 0, connectMs: 0, ttfbMs: 0, totalMs: 0, proxy: label, error: "No monitor URL." })
        continue
      }
      try {
        const response = await http.request({
          method: "GET",
          url,
          headers: headersFor(store, url),
          proxy,
          timeoutMs: 20000
        })
        samples.push(sampleFrom(store, label, response))
      } catch (err) {
        samples.push({
          store,
          ok: false,
          status: null,
          dnsMs: 0,
          connectMs: 0,
          ttfbMs: 0,
          totalMs: 0,
          proxy: label,
          error: err instanceof Error ? err.message : "The monitor request failed."
        })
      }
    }
    reports.push(summarizeBench(store, label, samples))
  }
  return reports
}

export function summarizeBench(store: StoreId, proxy: string, samples: BenchSample[]): BenchStoreReport {
  const success = samples.filter((sample) => sample.ok)
  const times = success.map((sample) => sample.totalMs)
  return {
    store,
    proxy,
    checks: samples.length,
    success: success.length,
    successRate: samples.length ? success.length / samples.length : 0,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    samples
  }
}

function sampleFrom(store: StoreId, proxy: string, response: HttpResponse): BenchSample {
  const timing = response.timing
  return {
    store,
    ok: monitorReadOk(response.status, response.body),
    status: response.status,
    dnsMs: timing?.dnsMs ?? 0,
    connectMs: timing?.connectMs ?? 0,
    ttfbMs: timing?.ttfbMs ?? 0,
    totalMs: timing?.totalMs ?? 0,
    proxy
  }
}

/** Open keep-alive connections for the tasks in a drop, on each task's monitor proxy. Read-only. */
export async function warmTaskMonitors(
  http: HttpClient,
  tasks: { store: StoreId; sku: string; monitorProxyGroupId?: string | null; proxyGroupId: string | null }[],
  groups: ProxyGroup[]
): Promise<void> {
  const buckets = new Map<string, { proxy?: ProxyEndpoint; urls: string[] }>()
  for (const task of tasks) {
    const url = monitorReadUrl(task.store, task.sku)
    if (!url) continue
    const groupId = task.monitorProxyGroupId || task.proxyGroupId
    const proxy = groups.find((group) => group.id === groupId)?.proxies[0]
    const key = proxy ? `${proxy.host}:${proxy.port}:${proxy.username ?? ""}` : "direct"
    const bucket = buckets.get(key) ?? { proxy, urls: [] }
    if (!bucket.urls.includes(url)) bucket.urls.push(url)
    buckets.set(key, bucket)
  }
  await Promise.all([...buckets.values()].map((bucket) => warmMonitorHosts(http, bucket.urls, bucket.proxy)))
}
