import { AppError } from "../shared/errors"
import type { SessionCookies, StoreId } from "../shared/types"
import { parseTcin } from "../shared/tcin"
import { parseAsin, productUrl as amazonProductUrl } from "../stores/amazon/parse"
import { monitorUrl, parseSku as parseBestBuySku } from "../stores/bestbuy/parse"
import { parseSku as parseCrunchyrollSku, productPageUrl } from "../stores/crunchyroll/parse"
import { productUrl as pokemonProductUrl } from "../stores/pokemon-center/parse"
import { parseItemId } from "../stores/walmart/parse"

export const COOKIE_LIMIT = 8192

const HOSTS: Record<StoreId, string> = {
  target: "www.target.com",
  walmart: "www.walmart.com",
  bestbuy: "www.bestbuy.com",
  "pokemon-center": "www.pokemoncenter.com",
  amazon: "www.amazon.com",
  crunchyroll: "www.crunchyroll.com"
}

/**
 * True only for an active challenge pause. Missing sessions, 2FA, CVV, and
 * "paste a session" messages stay ordinary pauses. A person solves the page.
 */
export function classifyChallenge(reason: string): boolean {
  const text = reason.toLowerCase()
  return text.includes("presented a challenge")
    || text.includes("presented a perimeterx")
    || text.includes("presented a robot check")
    || text.includes("asked for a captcha")
}

export function challengeHost(store: StoreId): string {
  return HOSTS[store]
}

export function challengePageUrl(store: StoreId, sku: string): string {
  const fallback = `https://${HOSTS[store]}/`
  if (store === "target") {
    const tcin = parseTcin(sku)
    return tcin ? `https://www.target.com/p/-/A-${tcin}` : fallback
  }
  if (store === "walmart") {
    const itemId = parseItemId(sku)
    return itemId ? `https://www.walmart.com/ip/${itemId}` : fallback
  }
  if (store === "bestbuy") {
    const id = parseBestBuySku(sku)
    return id ? monitorUrl(sku, id) : fallback
  }
  if (store === "pokemon-center") return pokemonProductUrl(sku, sku)
  if (store === "amazon") {
    const asin = parseAsin(sku)
    return asin ? amazonProductUrl(asin) : fallback
  }
  const crunchy = parseCrunchyrollSku(sku)
  return crunchy ? productPageUrl(crunchy) : fallback
}

export function splitCookieHeader(header: string): { name: string; value: string }[] {
  const pairs: { name: string; value: string }[] = []
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (!name || !value) continue
    if (name.length > 128 || value.length > 4096) continue
    if (!/^[\w!#$%&'*+\-.^`|~]+$/.test(name)) continue
    pairs.push({ name, value })
  }
  return pairs
}

export function cookieHeader(session?: SessionCookies): string {
  if (!session) return ""
  if (session.cookie?.trim()) return session.cookie.trim()
  const pairs: string[] = []
  if (session.accessToken && session.accessToken !== "session") pairs.push(`accessToken=${session.accessToken}`)
  if (session.visitorId) pairs.push(`visitorId=${session.visitorId}`)
  if (session.refreshToken) pairs.push(`refreshToken=${session.refreshToken}`)
  if (session.idToken) pairs.push(`idToken=${session.idToken}`)
  return pairs.join("; ")
}

/** Merge a solved cookie header into the account session. Keeps tokens the page did not replace. */
export function applySolvedCookies(existing: SessionCookies | undefined, header: string): SessionCookies {
  const cleaned = header.replace(/[ \t]+/g, " ").trim()
  if (!cleaned) throw new AppError("The solved session is empty.")
  if (/[\r\n]/.test(cleaned)) throw new AppError("The solved session has to be one cookie line.")
  if (cleaned.length > COOKIE_LIMIT) throw new AppError("The solved session is too large.")
  const map = new Map<string, string>()
  for (const pair of splitCookieHeader(cookieHeader(existing))) map.set(pair.name, pair.value)
  const incoming = splitCookieHeader(cleaned)
  if (!incoming.length) throw new AppError("The solved session has no cookies.")
  for (const pair of incoming) map.set(pair.name, pair.value)
  const cookie = [...map.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
  if (!cookie || cookie.length > COOKIE_LIMIT) throw new AppError("The solved session is too large.")
  const named = (keys: string[], fallback?: string) => {
    for (const key of keys) {
      const value = map.get(key)
      if (value) return value
    }
    return fallback
  }
  return {
    accessToken: named(["accessToken", "access_token", "auth", "at"], existing?.accessToken) || "session",
    visitorId: named(["visitorId", "visitorID", "visitor_id", "CID", "cid", "vt"], existing?.visitorId),
    refreshToken: named(["refreshToken", "refresh_token"], existing?.refreshToken),
    idToken: named(["idToken", "id_token"], existing?.idToken),
    cookie
  }
}
