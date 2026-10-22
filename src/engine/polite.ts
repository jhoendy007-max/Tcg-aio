import type { HttpClient, HttpRequest } from "./http"
import type { StoreId } from "../shared/types"
import { sleep } from "./sleep"

/** Minimum gap between this app's requests to one store. The configured delay can be longer. */
export const STORE_GAP_MS: Record<StoreId, number> = {
  target: 250,
  walmart: 400,
  bestbuy: 250,
  "pokemon-center": 400,
  amazon: 400,
  crunchyroll: 250,
  bandai: 400,
  gamestop: 400,
  "barnes-noble": 400,
  costco: 400,
  sams: 400,
  tcgplayer: 400
}

export const BLOCK_STATUSES = new Set([403, 412, 429, 435])

export function isBlockStatus(status: number | null): boolean {
  return status !== null && BLOCK_STATUSES.has(status)
}

/** Spread a monitor sleep by plus or minus pct. random is 0..1. */
export function jitterDelay(ms: number, pct: number, random: number): number {
  const span = Math.max(0, Math.min(40, pct)) / 100
  const unit = Math.max(0, Math.min(1, random))
  const factor = 1 - span + unit * span * 2
  return Math.max(250, Math.round(ms * factor))
}

/** Extra wait after repeated 403/412/429/435 responses. Caps at two minutes. */
export function backoffDelay(streak: number, baseMs: number): number {
  if (streak <= 0) return 0
  const steps = Math.min(Math.floor(streak), 5)
  return Math.min(120_000, Math.round(baseMs * 2 ** (steps - 1)))
}

/**
 * Spaces requests to one store and reports the status the site returned.
 * It does not change headers, TLS, or the body.
 */
export interface PaceShare {
  accountId?: string
  proxyId?: string
  /** This task's resolved rate limit. The built-in store gap is still the floor. */
  gapMs?: number
  /** This task's jitter. 0 keeps the gap exact. */
  jitterPct?: number
}

export function paceClock(store: StoreId, kind: "account" | "proxy" | "direct", id: string): string {
  return `${store}|${kind}:${id}`
}

export class PoliteLimiter {
  private readonly nextAt = new Map<string, number>()
  private readonly floors = new Map<StoreId, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => sleep(ms, signal ?? new AbortController().signal),
    private readonly random: () => number = Math.random
  ) {}

  /** A store page can slow requests down. It cannot go under the built-in gap. */
  setFloor(store: StoreId, ms: number): void {
    const floor = STORE_GAP_MS[store] ?? 1000
    this.floors.set(store, Math.max(floor, Math.round(ms)))
  }

  async before(store: StoreId, share: PaceShare = {}, signal?: AbortSignal): Promise<void> {
    const configured = share.gapMs ?? this.floors.get(store) ?? STORE_GAP_MS[store] ?? 1000
    const gap = Math.max(STORE_GAP_MS[store] ?? 1000, Math.round(configured))
    const keys = paceKeys(store, share)
    const delay = Math.max(0, ...keys.map((key) => (this.nextAt.get(key) ?? 0) - this.now()))
    if (delay > 0) await this.wait(delay, signal)
    const jitter = share.jitterPct ?? 0
    const step = jitter > 0 ? jitterDelay(gap, jitter, this.random()) : gap
    const next = this.now() + step
    for (const key of keys) this.nextAt.set(key, Math.max(this.nextAt.get(key) ?? 0, next))
  }

  wrap(
    store: StoreId,
    proxyId: string | undefined,
    inner: HttpClient,
    onStatus: (proxyId: string | undefined, status: number) => void,
    signal?: AbortSignal,
    pace?: PaceShare
  ): HttpClient {
    return {
      request: async (input: HttpRequest) => {
        const shareProxy = input.proxy?.id ?? pace?.proxyId ?? proxyId
        await this.before(store, { ...pace, proxyId: shareProxy }, input.signal ?? signal)
        const response = await inner.request(input)
        onStatus(shareProxy, response.status)
        return response
      }
    }
  }
}

function paceKeys(store: StoreId, share: PaceShare): string[] {
  const keys: string[] = []
  if (share.accountId) keys.push(paceClock(store, "account", share.accountId))
  if (share.proxyId) keys.push(paceClock(store, "proxy", share.proxyId))
  if (!keys.length) keys.push(paceClock(store, "direct", "direct"))
  return keys
}

/**
 * Slowest pace one IP should see from an anonymous monitor. Target's redsky API starts answering
 * HTTP 435 after a handful of fast requests from one IP, even a clean ISP proxy. A pool spreads the
 * same pace over more IPs, so the floor per check shrinks with the number of proxies.
 */
export const PER_PROXY_MIN_MS: Partial<Record<StoreId, number>> = { target: 10_000 }

export function perProxyFloorMs(store: StoreId, proxyCount: number): number {
  const floor = PER_PROXY_MIN_MS[store] ?? 0
  if (!floor) return 0
  return Math.round(floor / Math.max(1, proxyCount))
}

export function perProxyPaceLine(store: StoreId, proxyCount: number, delayMs: number): string | null {
  const floor = perProxyFloorMs(store, proxyCount)
  if (!floor || delayMs >= floor) return null
  const per = Math.round((PER_PROXY_MIN_MS[store] ?? 0) / 1000)
  const ips = proxyCount <= 1 ? "one IP" : `${proxyCount} IPs`
  return `Checking every ${(floor / 1000).toFixed(1)}s instead of ${(delayMs / 1000).toFixed(1)}s. With ${ips}, faster checks get blocked. Each proxy should see at most one check every ${per}s. Add proxies to check faster.`
}
