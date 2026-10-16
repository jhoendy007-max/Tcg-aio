import type { HttpClient } from "./http"
import { proxyLabel } from "../shared/proxy"
import { storeName } from "../shared/stores"
import { STORE_IDS, type ProxyEndpoint, type StoreHealth, type StoreId } from "../shared/types"

export type { StoreHealth }

const PROBES: Record<StoreId, string> = {
  target: "https://redsky.target.com/redsky_aggregations/v1/web/product_summary_with_fulfillment_v1?key=9f36aeafbe60771e321a7cc95a78140772ab3e96&tcins=88897904&store_id=1881&pricing_store_id=1881&zip=10001&state=NY&channel=WEB&page=%2Fp%2FA-88897904",
  walmart: "https://www.walmart.com/ip/13816151308",
  bestbuy: "https://www.bestbuy.com/site/searchpage.jsp?id=pcat17071&st=6606082",
  "pokemon-center": "https://www.pokemoncenter.com/",
  amazon: "https://www.amazon.com/",
  crunchyroll: "https://www.crunchyroll.com/store"
}

/** Read-only GET for every store. No cart, checkout, or place-order request is sent. */
export async function checkStoreHealth(http: HttpClient, proxies: ProxyEndpoint[] = []): Promise<StoreHealth[]> {
  const results: StoreHealth[] = []
  for (let index = 0; index < STORE_IDS.length; index += 1) {
    const store = STORE_IDS[index]
    const proxy = proxies.length ? proxies[index % proxies.length] : undefined
    const started = Date.now()
    try {
      const response = await http.request({
        method: "GET",
        url: PROBES[store],
        headers: { accept: "text/html,application/json", "user-agent": "TCGAIO-health" },
        proxy,
        timeoutMs: 20000
      })
      const verdict = classify(response.status, response.body)
      results.push({
        store,
        storeName: storeName(store),
        proxy: proxy ? proxyLabel(proxy) : "Direct",
        status: response.status,
        verdict,
        detail: verdict === "up" ? `HTTP ${response.status}` : verdict === "challenge" ? `HTTP ${response.status} looks like a challenge or block` : `HTTP ${response.status}`,
        ms: Date.now() - started
      })
    } catch (err) {
      results.push({
        store,
        storeName: storeName(store),
        proxy: proxy ? proxyLabel(proxy) : "Direct",
        status: null,
        verdict: "down",
        detail: err instanceof Error ? err.message : "The monitor request failed.",
        ms: Date.now() - started
      })
    }
  }
  return results
}

function classify(status: number, body: string): StoreHealth["verdict"] {
  const text = body.slice(0, 4000).toLowerCase()
  const challenge = status === 403 || status === 412 || status === 429 || status === 435
    || text.includes("captcha")
    || text.includes("access denied")
    || text.includes("just a moment")
    || text.includes("px-captcha")
    || text.includes("datadome")
    || text.includes("verify you are human")
  if (challenge) return "challenge"
  if (status >= 200 && status < 400) return "up"
  return "down"
}
