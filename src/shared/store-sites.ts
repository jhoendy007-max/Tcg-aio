import type { StoreId } from "./types"

/** Each supported store's main website, used by the Proxies page site test. */
export const STORE_SITES: Record<StoreId, string> = {
  target: "https://www.target.com/",
  walmart: "https://www.walmart.com/",
  bestbuy: "https://www.bestbuy.com/",
  "pokemon-center": "https://www.pokemoncenter.com/",
  amazon: "https://www.amazon.com/",
  crunchyroll: "https://store.crunchyroll.com/",
  bandai: "https://p-bandai.com/us/",
  gamestop: "https://www.gamestop.com/",
  "barnes-noble": "https://www.barnesandnoble.com/",
  costco: "https://www.costco.com/",
  sams: "https://www.samsclub.com/",
  tcgplayer: "https://www.tcgplayer.com/"
}

/** Only https URLs; the custom option cannot point at local or private hosts. */
export function cleanSiteUrl(input: string): string | null {
  try {
    const url = new URL(input.trim())
    if (url.protocol !== "https:") return null
    const host = url.hostname.toLowerCase()
    if (host === "localhost" || host.endsWith(".local") || /^(\d+\.){3}\d+$/.test(host) || host.includes(":")) return null
    return url.toString()
  } catch {
    return null
  }
}
