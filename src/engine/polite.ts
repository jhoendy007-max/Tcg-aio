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
  bandai: 400
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
export class PoliteLimiter {
  private readonly nextAt = new Map<StoreId, number>()
  private readonly floors = new Map<StoreId, number>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => sleep(ms, signal ?? new AbortController().signal)
  ) {}

  /** A store page can slow requests down. It cannot go under the built-in gap. */
  setFloor(store: StoreId, ms: number): void {
    const floor = STORE_GAP_MS[store] ?? 1000
    this.floors.set(store, Math.max(floor, Math.round(ms)))
  }

  async before(store: StoreId, signal?: AbortSignal): Promise<void> {
    const gap = this.floors.get(store) ?? STORE_GAP_MS[store] ?? 1000
    const delay = Math.max(0, (this.nextAt.get(store) ?? 0) - this.now())
    if (delay > 0) await this.wait(delay, signal)
    this.nextAt.set(store, this.now() + gap)
  }

  wrap(
    store: StoreId,
    proxyId: string | undefined,
    inner: HttpClient,
    onStatus: (proxyId: string | undefined, status: number) => void,
    signal?: AbortSignal
  ): HttpClient {
    return {
      request: async (input: HttpRequest) => {
        await this.before(store, input.signal ?? signal)
        const response = await inner.request(input)
        onStatus(input.proxy?.id ?? proxyId, response.status)
        return response
      }
    }
  }
}
