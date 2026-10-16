import { proxyLabel } from "../shared/proxy"
import type { ProxyEndpoint, ProxyTestResult } from "../shared/types"
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
