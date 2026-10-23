import { percentile } from "./monitor"
import { STORE_GAP_MS } from "./polite"
import { chromeUserAgent } from "./chrome-ua"
import type { HttpClient, HttpResponse } from "./http"
import { defaultHttp, warmMonitorHosts } from "./http"
import { offersUrl, parseAsin } from "../stores/amazon/parse"
import { parseSku as parseBandai, productApiUrl as bandaiProduct } from "../stores/bandai/parse"
import { BARNES_NOBLE, COSTCO, GAMESTOP, SAMS, parsePageTarget, type PageSpec } from "../stores/page/parse"
import { detailsUrl, parseProductId } from "../stores/tcgplayer/parse"
import { monitorUrl, parseSku as parseBestBuy } from "../stores/bestbuy/parse"
import { parseSku as parseCrunchy, productApiUrl as crunchyProduct } from "../stores/crunchyroll/parse"
import { parseSku as parsePokemon, searchUrl } from "../stores/pokemon-center/parse"
import { parseTcin } from "../shared/tcin"
import { parseItemId } from "../stores/walmart/parse"
import { STORE_IDS, type MonitorVerdict, type ProxyEndpoint, type ProxyGroup, type StoreId } from "../shared/types"
import { parseStock as targetStock } from "../stores/target/parse"
import { readStock as walmartStock } from "../stores/walmart/parse"
import { readStock as bestbuyStock } from "../stores/bestbuy/parse"
import { readStock as pokemonStock } from "../stores/pokemon-center/parse"
import { readOffers as amazonOffers } from "../stores/amazon/parse"
import { readStock as crunchyStock } from "../stores/crunchyroll/parse"
import { readStock as bandaiStock } from "../stores/bandai/parse"
import { readPageOffer } from "../stores/page/parse"
import { readListings, readProduct } from "../stores/tcgplayer/parse"

/** Public read-only monitor URLs. These match the stock checks, not cart or checkout. */
/**
 * Real Pokemon TCG products (0.2.37). Costco, Sam's, B&N, and Crunchyroll replaced placeholder ids
 * that never matched a product and so always looked "blocked" or "error".
 */
export const BENCH_SKUS: Record<StoreId, string> = {
  target: "88897904",
  walmart: "13816151308",
  bestbuy: "6606082",
  "pokemon-center": "699-85207",
  amazon: "B0BSHF7WHW",
  // Pokemon TCG: Mega Evolution Chaos Rising Elite Trainer Box
  crunchyroll: "196214154117",
  bandai: "N2716225001",
  gamestop: "436435",
  // Pokemon Scarlet & Violet Prismatic Evolutions Elite Trainer Box
  "barnes-noble": "https://www.barnesandnoble.com/w/pokemon-scarlet-violet-s85-prismatic-evolutions-elite-trainer-box-pokemon/1146574246",
  // Pokemon TCG: Charizard ex Super-Premium Collection
  costco: "4000313298",
  // SV8.5 Prismatic Evolutions Super Premium Collection
  sams: "https://www.samsclub.com/ip/sv8-5-prismatic-evolutions-super-premium-collection/19170800669",
  tcgplayer: "509980"
}

/** Monitor-style request timeout for the benchmark and the Proxies page tests. */
export const BENCH_TIMEOUT_MS = 8000

export interface BenchSample {
  store: StoreId
  ok: boolean
  verdict: MonitorVerdict
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
  inStock: number
  outOfStock: number
  blocked: number
  timeouts: number
  parseErrors: number
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
  if (store === "bandai") {
    const code = parseBandai(sku)
    return code ? bandaiProduct(code) : null
  }
  if (store === "gamestop") return benchPage(GAMESTOP, sku)
  if (store === "barnes-noble") return benchPage(BARNES_NOBLE, sku)
  if (store === "costco") return benchPage(COSTCO, sku)
  if (store === "sams") return benchPage(SAMS, sku)
  if (store === "tcgplayer") {
    const id = parseProductId(sku)
    return id ? detailsUrl(id) : null
  }
  const _exhaustive: never = store
  return _exhaustive
}

function benchPage(spec: PageSpec, sku: string): string | null {
  return parsePageTarget(spec, sku)?.url ?? null
}

function headersFor(store: StoreId, url: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: store === "target" || store === "pokemon-center" || store === "crunchyroll" || store === "bandai" || store === "tcgplayer" ? "application/json" : "text/html,application/json",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": chromeUserAgent()
  }
  if (store === "bandai") {
    headers["x-g1-area-code"] = "us"
    headers["x-requested-with"] = "XMLHttpRequest"
    headers.referer = "https://p-bandai.com/us/"
  }
  if (store === "target") headers.referer = "https://www.target.com/"
  if (store === "amazon") headers.referer = "https://www.amazon.com/"
  if (store === "crunchyroll") headers.referer = url
  if (store === "tcgplayer") {
    headers.origin = "https://www.tcgplayer.com"
    headers.referer = "https://www.tcgplayer.com/"
  }
  return headers
}

/** A 2xx body that is not a block page. Monitors do not follow redirects, so a 3xx is a block (captcha/bot wall). */
export function monitorReadOk(status: number, body: string): boolean {
  if (status < 200 || status >= 300) return false
  const text = body.slice(0, 2000).toLowerCase()
  if (text.includes("access denied") || text.includes("just a moment") || text.includes("verify you are human") || text.includes("px-captcha")) return false
  return true
}

const BLOCK_RE = /access denied|just a moment|verify you are human|px-captcha|captcha|datadome|are-you-human|perimeterx|request unsuccessful|robot check/i

/** True for a block: 3xx (monitors never follow), 403/412/429/435/503, or a challenge page. */
export function isBlocked(status: number, body: string): boolean {
  if (status >= 300 && status < 400) return true
  if (status === 403 || status === 412 || status === 429 || status === 435 || status === 503) return true
  return BLOCK_RE.test(body.slice(0, 6000))
}

export function isTimeout(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return /time(d)? ?out|ETIMEDOUT|AbortError|aborted/i.test(text)
}

/** Run the store's real stock parser on a monitor response. */
export function readMonitor(store: StoreId, sku: string, status: number, body: string): { verdict: MonitorVerdict; title?: string; detail: string } {
  if (isBlocked(status, body)) return { verdict: "blocked", detail: `Blocked (HTTP ${status})` }
  if (status < 200 || status >= 300) return { verdict: "error", detail: `HTTP ${status}` }
  try {
    const reading = parseFor(store, sku, body)
    if (!reading) return { verdict: "parse-error", detail: "The page loaded but the stock parser found no product." }
    return { verdict: reading.inStock ? "in" : "oos", title: reading.title, detail: reading.inStock ? "In stock" : "Out of stock" }
  } catch (err) {
    return { verdict: "parse-error", detail: err instanceof Error ? err.message.slice(0, 120) : "The stock parser failed." }
  }
}

function parseFor(store: StoreId, sku: string, body: string): { inStock: boolean; title?: string } | null {
  switch (store) {
    case "target": return targetStock(body)
    case "walmart": return walmartStock(body)
    case "bestbuy": { const id = parseBestBuy(sku); return id ? bestbuyStock(body, id) : null }
    case "pokemon-center": { const id = parsePokemon(sku); return id ? pokemonStock(body, id) : null }
    case "amazon": {
      if (!/aod-|offer/i.test(body)) return null
      return { inStock: amazonOffers(body).length > 0 }
    }
    case "crunchyroll": { const id = parseCrunchy(sku); return id ? crunchyStock(body, id) : null }
    case "bandai": { const id = parseBandai(sku); return id ? bandaiStock(body, id) : null }
    case "gamestop": return pageRead(GAMESTOP, sku, body)
    case "barnes-noble": return pageRead(BARNES_NOBLE, sku, body)
    case "costco": return pageRead(COSTCO, sku, body)
    case "sams": return pageRead(SAMS, sku, body)
    case "tcgplayer": {
      const id = parseProductId(sku)
      const product = id ? readProduct(body, id) : null
      if (!product) return null
      return { inStock: readListings(body).length > 0 || (product.marketPrice ?? 0) > 0, title: product.title }
    }
  }
}

function pageRead(spec: PageSpec, sku: string, body: string): { inStock: boolean; title?: string } | null {
  const target = parsePageTarget(spec, sku)
  if (!target) return null
  const reading = readPageOffer(spec, body, target.sku)
  // No product JSON-LD and no add-to-cart control: the page is not a product page we can read.
  if (!reading.title && !reading.inStock) return null
  return { inStock: reading.inStock, title: reading.title }
}

/** One monitor request through one proxy, read with the store's stock parser. */
export async function probeMonitor(http: HttpClient, store: StoreId, sku: string, proxy?: ProxyEndpoint): Promise<{ status: number | null; ms: number | null; verdict: MonitorVerdict; detail: string; title?: string }> {
  const url = monitorReadUrl(store, sku)
  if (!url) return { status: null, ms: null, verdict: "parse-error", detail: "This product id does not parse for the store." }
  const started = Date.now()
  try {
    const response = await http.request({ method: "GET", url, headers: headersFor(store, url), proxy, redirect: "manual", timeoutMs: BENCH_TIMEOUT_MS })
    const ms = Math.round(response.timing?.totalMs || Date.now() - started)
    return { status: response.status, ms, ...readMonitor(store, sku, response.status, response.body) }
  } catch (err) {
    if (isTimeout(err)) return { status: null, ms: null, verdict: "timeout", detail: `No answer in ${BENCH_TIMEOUT_MS / 1000}s` }
    return { status: null, ms: null, verdict: "error", detail: err instanceof Error ? err.message.slice(0, 160) : "The request failed." }
  }
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
        samples.push({ store, ok: false, verdict: "parse-error", status: null, dnsMs: 0, connectMs: 0, ttfbMs: 0, totalMs: 0, proxy: label, error: "No monitor URL." })
        continue
      }
      const started = Date.now()
      try {
        const response = await http.request({
          method: "GET",
          url,
          headers: headersFor(store, url),
          proxy,
          redirect: "manual",
          timeoutMs: BENCH_TIMEOUT_MS
        })
        samples.push(sampleFrom(store, BENCH_SKUS[store], label, response, Date.now() - started))
      } catch (err) {
        samples.push({
          store,
          ok: false,
          verdict: isTimeout(err) ? "timeout" : "error",
          status: null,
          dnsMs: 0,
          connectMs: 0,
          ttfbMs: 0,
          totalMs: 0,
          proxy: label,
          error: isTimeout(err) ? `No answer in ${BENCH_TIMEOUT_MS / 1000}s` : err instanceof Error ? err.message : "The monitor request failed."
        })
      }
    }
    reports.push(summarizeBench(store, label, samples))
  }
  return reports
}

export function summarizeBench(store: StoreId, proxy: string, samples: BenchSample[]): BenchStoreReport {
  const success = samples.filter((sample) => sample.ok)
  const times = samples.filter((sample) => sample.totalMs > 0).map((sample) => sample.totalMs)
  return {
    store,
    proxy,
    checks: samples.length,
    success: success.length,
    successRate: samples.length ? success.length / samples.length : 0,
    inStock: samples.filter((sample) => sample.verdict === "in").length,
    outOfStock: samples.filter((sample) => sample.verdict === "oos").length,
    blocked: samples.filter((sample) => sample.verdict === "blocked").length,
    timeouts: samples.filter((sample) => sample.verdict === "timeout").length,
    parseErrors: samples.filter((sample) => sample.verdict === "parse-error").length,
    p50Ms: percentile(times, 50),
    p95Ms: percentile(times, 95),
    samples
  }
}

function sampleFrom(store: StoreId, sku: string, proxy: string, response: HttpResponse, elapsedMs: number): BenchSample {
  const timing = response.timing
  const read = readMonitor(store, sku, response.status, response.body)
  return {
    store,
    // A good sample is one the stock parser could read (in stock or out of stock).
    ok: read.verdict === "in" || read.verdict === "oos",
    verdict: read.verdict,
    status: response.status,
    dnsMs: timing?.dnsMs ?? 0,
    connectMs: timing?.connectMs ?? 0,
    ttfbMs: timing?.ttfbMs ?? 0,
    totalMs: timing?.totalMs || elapsedMs,
    proxy,
    ...(read.verdict === "in" || read.verdict === "oos" ? {} : { error: read.detail })
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
