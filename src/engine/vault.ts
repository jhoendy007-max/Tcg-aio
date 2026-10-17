import { cookieHeader } from "./challenge"
import { storeName } from "../shared/stores"
import type { PublicAccount, SessionCookies, VaultLink } from "../shared/types"

const EXPIRING_MS = 36 * 60 * 60 * 1000

export type VaultFlag = "ok" | "expiring" | "logged-out"

export interface VaultNotice {
  accountId: string
  deviceId: string
  loggedOut: boolean
  storeName: string
  label: string
  detail: string
}

export function vaultFlag(link: Pick<VaultLink, "expiresAt" | "loggedOut">, sessionState: PublicAccount["sessionState"], now: number): VaultFlag {
  if (link.loggedOut || sessionState === "expired" || sessionState === "missing") return "logged-out"
  if (link.expiresAt && link.expiresAt <= now) return "logged-out"
  if (link.expiresAt && link.expiresAt - now <= EXPIRING_MS) return "expiring"
  return "ok"
}

/** A link that has never synced is shown as logged out, but it does not page the user yet. */
function alertable(link: VaultLink, account: PublicAccount, now: number): boolean {
  const flag = vaultFlag(link, account.sessionState, now)
  if (flag === "ok") return false
  if (flag === "logged-out" && !link.loggedOut && account.sessionState === "missing" && !link.expiresAt) return false
  return true
}

export function alertsFor(links: VaultLink[], accounts: PublicAccount[], now: number, day: string): VaultLink[] {
  return links.filter((link) => {
    if (link.alertedDay === day) return false
    const account = accounts.find((item) => item.id === link.accountId)
    if (!account) return false
    return alertable(link, account, now)
  })
}

export function cookieForVault(session: SessionCookies | undefined): string {
  return cookieHeader(session)
}

/** Expiry comes from the saved session. This does not open a store login page. */
export function vaultScan(links: VaultLink[], accounts: PublicAccount[], now: number, day: string): { expireIds: string[]; notices: VaultNotice[] } {
  const expireIds: string[] = []
  for (const link of links) {
    const account = accounts.find((item) => item.id === link.accountId)
    if (!account || account.sessionState !== "saved") continue
    const stale = link.loggedOut || (typeof link.expiresAt === "number" && link.expiresAt <= now)
    if (stale && !expireIds.includes(link.accountId)) expireIds.push(link.accountId)
  }
  const notices: VaultNotice[] = []
  for (const link of alertsFor(links, accounts, now, day)) {
    const account = accounts.find((item) => item.id === link.accountId)
    if (!account) continue
    const flag = vaultFlag(link, account.sessionState, now)
    const name = storeName(account.store)
    notices.push({
      accountId: link.accountId,
      deviceId: link.deviceId,
      loggedOut: flag === "logged-out",
      storeName: name,
      label: account.label,
      detail: flag === "logged-out"
        ? `${account.label} at ${name} is logged out. Sign in again in your browser. Session Sync sends only that account.`
        : `${account.label} at ${name} expires soon. Sign in again before the saved session ends.`
    })
  }
  return { expireIds, notices }
}
