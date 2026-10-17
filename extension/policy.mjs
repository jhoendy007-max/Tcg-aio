/** Hosts the extension may read. One registrable site per store. */
export const STORE_SITES = {
  target: "target.com",
  walmart: "walmart.com",
  bestbuy: "bestbuy.com",
  "pokemon-center": "pokemoncenter.com",
  amazon: "amazon.com",
  crunchyroll: "crunchyroll.com",
  bandai: "p-bandai.com",
  gamestop: "gamestop.com",
  "barnes-noble": "barnesandnoble.com",
  costco: "costco.com",
  sams: "samsclub.com",
  tcgplayer: "tcgplayer.com"
}

/** localStorage names the store itself writes. Anything else is ignored. */
export const STORAGE_KEYS = {
  target: ["accessToken", "refreshToken", "idToken"],
  walmart: ["auth", "CID"],
  bestbuy: ["at", "vt"],
  "pokemon-center": [],
  amazon: [],
  crunchyroll: ["accessToken"],
  bandai: [],
  gamestop: [],
  "barnes-noble": [],
  costco: [],
  sams: [],
  tcgplayer: []
}

/** Same origins Session Keeper already opens. Two-way writes land only here. */
export const STORE_ORIGINS = {
  target: "https://www.target.com/",
  walmart: "https://www.walmart.com/",
  bestbuy: "https://www.bestbuy.com/",
  "pokemon-center": "https://www.pokemoncenter.com/",
  amazon: "https://www.amazon.com/",
  crunchyroll: "https://www.crunchyroll.com/",
  bandai: "https://p-bandai.com/",
  gamestop: "https://www.gamestop.com/",
  "barnes-noble": "https://www.barnesandnoble.com/",
  costco: "https://www.costco.com/",
  sams: "https://www.samsclub.com/",
  tcgplayer: "https://www.tcgplayer.com/"
}

export const COOKIE_LIMIT = 8192

export function siteOf(store) {
  return STORE_SITES[store] ?? ""
}

export function domainAllowed(store, domain) {
  const site = siteOf(store)
  if (!site) return false
  const host = String(domain || "").replace(/^\./, "").toLowerCase()
  return host === site || host.endsWith(`.${site}`)
}

export function selectCookies(store, cookies) {
  return (cookies || []).filter((cookie) => cookie && cookie.name && cookie.value && domainAllowed(store, cookie.domain))
}

export function selectStorage(store, entries) {
  const allowed = new Set(STORAGE_KEYS[store] ?? [])
  return (entries || []).filter((entry) => entry && allowed.has(entry.key) && entry.value)
}

export function cookieHeader(store, cookies, storage) {
  const pairs = []
  const seen = new Set()
  for (const cookie of selectCookies(store, cookies)) {
    if (seen.has(cookie.name)) continue
    seen.add(cookie.name)
    pairs.push(`${cookie.name}=${cookie.value}`)
  }
  for (const entry of selectStorage(store, storage)) {
    if (seen.has(entry.key)) continue
    seen.add(entry.key)
    pairs.push(`${entry.key}=${entry.value}`)
  }
  const header = pairs.join("; ")
  if (header.length > COOKIE_LIMIT) return header.slice(0, COOKIE_LIMIT)
  return header
}

export function pairsFromHeader(header) {
  const pairs = []
  for (const part of String(header || "").split(";")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name || !value) continue
    if (!/^[\w!#$%&'*+\-.^`|~]+$/.test(name)) continue
    pairs.push({ name, value })
  }
  return pairs
}

export function earliestStoreExpiry(store, cookies) {
  const times = selectCookies(store, cookies)
    .map((cookie) => Number(cookie.expirationDate))
    .filter((time) => Number.isFinite(time) && time > 0)
  if (!times.length) return null
  return Math.min(...times) * 1000
}
