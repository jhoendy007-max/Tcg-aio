import { BENCH_SKUS, monitorReadHeaders, monitorReadUrl } from "./bench"
import { proxyLabel } from "../shared/proxy"
import { storeName } from "../shared/stores"
import { STORE_IDS, type ProxyEndpoint, type ProxyStoreProbe, type ProxyStoreTestResult, type ProxyTestResult } from "../shared/types"
import type { HttpClient } from "./http"
import { defaultHttp } from "./http"

export async function testProxies(proxies: ProxyEndpoint[], http: HttpClient = defaultHttp): Promise<ProxyTestResult[]> {
  const results: ProxyTestResult[] = []
  const queue = proxies.slice()
  const workers = Array.from({ length: Math.min(5, queue.length) }, async () => {
    while (queue.length) {
      const proxy = queue.shift()
      if (!proxy) return
      results.push(await testOne(proxy, http))
    }
  })
  await Promise.all(workers)
  return proxies.map((proxy) => results.find((result) => result.id === proxy.id) ?? {
    id: proxy.id,
    label: proxyLabel(proxy),
    ok: false,
    error: "Not tested"
  })
}

const BLOCK_STATUSES = new Set([403, 412, 429, 435])

/** One read-only monitor request per store. Cart and checkout URLs are not used. */
export async function testProxiesAgainstStores(proxies: ProxyEndpoint[], http: HttpClient = defaultHttp): Promise<ProxyStoreTestResult[]> {
  const results: ProxyStoreTestResult[] = []
  const queue = proxies.slice()
  const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
    while (queue.length) {
      const proxy = queue.shift()
      if (!proxy) return
      results.push(await testOneAgainstStores(proxy, http))
    }
  })
  await Promise.all(workers)
  return proxies.map((proxy) => results.find((result) => result.id === proxy.id) ?? {
    id: proxy.id,
    label: proxyLabel(proxy),
    probes: []
  })
}

export function storeProbeVerdict(status: number, body: string): ProxyStoreProbe["verdict"] {
  const text = body.slice(0, 4000).toLowerCase()
  const challenge = BLOCK_STATUSES.has(status)
    || text.includes("captcha")
    || text.includes("access denied")
    || text.includes("px-captcha")
    || text.includes("verify you are human")
    || text.includes("just a moment")
    || text.includes("pardon our interruption")
  if (challenge) return "blocked"
  if (status >= 200 && status < 400) return "ok"
  return "error"
}

async function testOneAgainstStores(proxy: ProxyEndpoint, http: HttpClient): Promise<ProxyStoreTestResult> {
  const probes: ProxyStoreProbe[] = []
  for (const store of STORE_IDS) {
    const url = monitorReadUrl(store, BENCH_SKUS[store])
    if (!url) {
      probes.push({ store, storeName: storeName(store), verdict: "error", detail: "No monitor URL." })
      continue
    }
    try {
      const response = await http.request({
        method: "GET",
        url,
        headers: monitorReadHeaders(store, url),
        proxy,
        timeoutMs: 15000
      })
      const verdict = storeProbeVerdict(response.status, response.body)
      probes.push({
        store,
        storeName: storeName(store),
        verdict,
        detail: verdict === "ok" ? "OK" : verdict === "blocked" ? "Blocked" : `HTTP ${response.status}`
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "The store did not answer."
      probes.push({ store, storeName: storeName(store), verdict: "error", detail: message })
    }
  }
  return { id: proxy.id, label: proxyLabel(proxy), probes }
}

async function testOne(proxy: ProxyEndpoint, http: HttpClient): Promise<ProxyTestResult> {
  const label = proxyLabel(proxy)
  try {
    const response = await http.request({
      method: "GET",
      url: "https://api.ipify.org?format=json",
      proxy,
      timeoutMs: 12000
    })
    if (response.status < 200 || response.status >= 300) {
      return { id: proxy.id, label, ok: false, error: `HTTP ${response.status}` }
    }
    const parsed = JSON.parse(response.body) as { ip?: string }
    return { id: proxy.id, label, ok: true, ip: parsed.ip }
  } catch (err) {
    return { id: proxy.id, label, ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
