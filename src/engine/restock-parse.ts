import { parseSku as parseBandaiSku } from "../stores/bandai/parse"
import { BARNES_NOBLE, COSTCO, GAMESTOP, SAMS, parsePageSku } from "../stores/page/parse"
import { parseProductId } from "../stores/tcgplayer/parse"
import { parseAsin } from "../stores/amazon/parse"
import { parseSku as parseBestBuySku } from "../stores/bestbuy/parse"
import { parseSku as parseCrunchyrollSku } from "../stores/crunchyroll/parse"
import { parseSku as parsePokemonSku } from "../stores/pokemon-center/parse"
import { parseItemId } from "../stores/walmart/parse"
import { parseTcin } from "../shared/tcin"
import { isStoreId } from "../shared/stores"
import type { StoreId } from "../shared/types"

export interface RestockSignal {
  store: StoreId
  sku: string
  title: string
  price: number | null
  url: string
  quantity: number | null
  soldBy: string
  inStock: boolean
  source: string
}

const STORE_ALIASES: Record<string, StoreId> = {
  target: "target",
  walmart: "walmart",
  bestbuy: "bestbuy",
  "best buy": "bestbuy",
  "best-buy": "bestbuy",
  "pokemon-center": "pokemon-center",
  "pokemon center": "pokemon-center",
  pokemoncenter: "pokemon-center",
  "pokémon center": "pokemon-center",
  "pokemon centre": "pokemon-center",
  amazon: "amazon",
  crunchyroll: "crunchyroll",
  "crunchyroll store": "crunchyroll",
  bandai: "bandai",
  "premium bandai": "bandai",
  "p-bandai": "bandai",
  premiumbandai: "bandai",
  gamestop: "gamestop",
  "game stop": "gamestop",
  "barnes-noble": "barnes-noble",
  "barnes & noble": "barnes-noble",
  "barnes and noble": "barnes-noble",
  barnesandnoble: "barnes-noble",
  costco: "costco",
  sams: "sams",
  "sam's club": "sams",
  "sams club": "sams",
  samsclub: "sams",
  tcgplayer: "tcgplayer",
  "tcgplayer direct": "tcgplayer",
  "tcg player": "tcgplayer"
}

export function storeFromName(value: string): StoreId | null {
  const key = value.trim().toLowerCase().replace(/\s+/g, " ")
  return STORE_ALIASES[key] ?? (isStoreId(key) ? key : null)
}

export function parseWebhook(value: unknown): { signals: RestockSignal[] } | { error: string } {
  const items = Array.isArray(value) ? value : [value]
  if (!items.length) return { error: "JSON body is empty." }
  const signals: RestockSignal[] = []
  for (const item of items) {
    const signal = oneSignal(item)
    if ("error" in signal) return signal
    signals.push(signal)
  }
  return { signals }
}

export function parseDiscordContent(content: string): RestockSignal[] {
  const text = content.trim()
  if (!text) return []
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = parseWebhook(JSON.parse(text))
      if ("signals" in parsed) return parsed.signals.filter((signal) => signal.inStock)
    } catch {
      // The message is ordinary text that happens to start with a brace.
    }
  }
  const found: RestockSignal[] = []
  const urls = text.match(/https?:\/\/[^\s<>)]+/gi) ?? []
  for (const url of urls) {
    const signal = signalFromUrl(url.replace(/[.,]$/, ""))
    if (signal) found.push(signal)
  }
  for (const line of text.split(/\n+/)) {
    const labeled = line.match(/^(target|walmart|best\s*buy|pok[eé]mon\s*cent(?:er|re)|amazon|crunchyroll(?:\s+store)?|premium\s*bandai|p-bandai|bandai|game\s*stop|barnes\s*(?:&|and)\s*noble|costco|sam'?s\s*club|tcg\s*player(?:\s+direct)?)\b[:|\s-]+(\S+)/i)
    if (!labeled) continue
    const store = storeFromName(labeled[1])
    if (!store) continue
    const sku = skuForStore(store, labeled[2])
    if (!sku) continue
    if (found.some((signal) => signal.store === store && signal.sku === sku)) continue
    found.push({
      store,
      sku,
      title: line.replace(labeled[0], "").replace(/\$\d+(?:\.\d{2})?/, "").trim(),
      price: readPrice(line),
      url: "",
      quantity: null,
      soldBy: "",
      inStock: true,
      source: "discord"
    })
  }
  return found
}

function oneSignal(value: unknown): RestockSignal | { error: string } {
  if (!value || typeof value !== "object") return { error: "Each restock event must be a JSON object." }
  const record = value as Record<string, unknown>
  const url = stringField(record, ["url", "link"])
  const named = storeFromName(stringField(record, ["store", "retailer", "shop"]))
  const fromUrl = url ? signalFromUrl(url) : null
  const store = named ?? fromUrl?.store ?? null
  if (!store) return { error: "store is required. Use target, walmart, bestbuy, pokemon-center, amazon, crunchyroll, bandai, gamestop, barnes-noble, costco, sams, or tcgplayer." }
  const sku = skuForStore(store, stringField(record, ["sku", "tcin", "itemId", "usItemId", "asin", "productId", "pid"])) ?? fromUrl?.sku ?? ""
  if (!sku) return { error: "sku is required, or put a product URL in url." }
  const inStock = readStockFlag(record.inStock ?? record.in_stock ?? record.stock)
  return {
    store,
    sku,
    title: stringField(record, ["title", "name", "product"]),
    price: readPrice(record.price ?? record.currentPrice ?? record.current_price),
    url,
    quantity: readQuantity(record.quantity ?? record.qty),
    soldBy: stringField(record, ["soldBy", "sold_by", "seller"]),
    inStock,
    source: stringField(record, ["source"]) || "webhook"
  }
}

function signalFromUrl(url: string): RestockSignal | null {
  let host = ""
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
  const store = storeFromHost(host)
  if (!store) return null
  const sku = skuForStore(store, url)
  if (!sku) return null
  return { store, sku, title: "", price: null, url, quantity: null, soldBy: "", inStock: true, source: "discord" }
}

function storeFromHost(host: string): StoreId | null {
  if (host.endsWith("target.com")) return "target"
  if (host.endsWith("walmart.com")) return "walmart"
  if (host.endsWith("bestbuy.com")) return "bestbuy"
  if (host.endsWith("pokemoncenter.com")) return "pokemon-center"
  if (host.endsWith("amazon.com")) return "amazon"
  if (host.endsWith("crunchyroll.com")) return "crunchyroll"
  if (host.endsWith("p-bandai.com") || host.endsWith("premiumbandai.com")) return "bandai"
  if (host.endsWith("gamestop.com")) return "gamestop"
  if (host.endsWith("barnesandnoble.com")) return "barnes-noble"
  if (host === "costco.com" || host.endsWith(".costco.com")) return "costco"
  if (host.endsWith("samsclub.com")) return "sams"
  if (host.endsWith("tcgplayer.com")) return "tcgplayer"
  return null
}

function skuForStore(store: StoreId, value: string): string | null {
  if (!value) return null
  if (store === "target") return parseTcin(value)
  if (store === "walmart") return parseItemId(value)
  if (store === "bestbuy") return parseBestBuySku(value)
  if (store === "pokemon-center") return parsePokemonSku(value)
  if (store === "amazon") return parseAsin(value)
  if (store === "bandai") return parseBandaiSku(value)
  if (store === "crunchyroll") return parseCrunchyrollSku(value)
  if (store === "gamestop") return parsePageSku(GAMESTOP, value)
  if (store === "barnes-noble") return parsePageSku(BARNES_NOBLE, value)
  if (store === "costco") return parsePageSku(COSTCO, value)
  if (store === "sams") return parsePageSku(SAMS, value)
  if (store === "tcgplayer") return parseProductId(value)
  const _exhaustive: never = store
  return _exhaustive
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return ""
}

function readPrice(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return roundMoney(value)
  if (typeof value === "string") {
    const cleaned = value.replace(/,/g, "")
    const dollar = cleaned.match(/\$(\d+(?:\.\d{1,2})?)/)
    if (dollar) return roundMoney(Number(dollar[1]))
    if (/^\s*\d+(?:\.\d{1,2})?\s*$/.test(cleaned)) return roundMoney(Number(cleaned))
  }
  return null
}

function readQuantity(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isFinite(number)) return null
  const rounded = Math.round(number)
  if (rounded < 1 || rounded > 12) return null
  return rounded
}

function readStockFlag(value: unknown): boolean {
  if (value === undefined) return true
  if (value === false || value === 0) return false
  if (typeof value === "string") {
    const text = value.trim().toLowerCase()
    if (["out", "oos", "out_of_stock", "false", "sold_out", "sold out"].includes(text)) return false
  }
  return true
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}
