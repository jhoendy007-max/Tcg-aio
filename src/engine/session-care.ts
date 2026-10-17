import { accountPartition } from "../shared/consistency"
import type { StoreId } from "../shared/types"
import { challengeHost, splitCookieHeader } from "./challenge"

const HOMES: Record<StoreId, string> = {
  target: "https://www.target.com/",
  walmart: "https://www.walmart.com/",
  bestbuy: "https://www.bestbuy.com/",
  "pokemon-center": "https://www.pokemoncenter.com/",
  amazon: "https://www.amazon.com/",
  crunchyroll: "https://www.crunchyroll.com/",
  bandai: "https://p-bandai.com/us",
  gamestop: "https://www.gamestop.com/",
  "barnes-noble": "https://www.barnesandnoble.com/",
  costco: "https://www.costco.com/",
  sams: "https://www.samsclub.com/",
  tcgplayer: "https://www.tcgplayer.com/"
}

const LOGIN_URL = /\/(?:login|signin|sign-in|ap\/signin|identity\/signin|account\/login)(?:[/?#]|$)/i

export function storeHome(store: StoreId): string {
  return HOMES[store]
}

export function warmupDue(lastWarmAt: number | null, intervalMin: number, now: number): boolean {
  if (!lastWarmAt) return true
  return now - lastWarmAt >= intervalMin * 60_000
}

/**
 * A real page landed on a sign-in URL, or the browser stored no cookies.
 * This does not decide how the store's own scripts behave.
 */
export function looksSignedOut(finalUrl: string, cookieHeader: string): boolean {
  if (LOGIN_URL.test(finalUrl)) return true
  return splitCookieHeader(cookieHeader).length === 0
}

export function sessionPartition(accountId: string): string {
  return accountPartition(accountId)
}

export function sessionOrigin(store: StoreId): string {
  return `https://${challengeHost(store)}/`
}
