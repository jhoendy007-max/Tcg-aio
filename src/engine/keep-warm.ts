import type { StoreId } from "../shared/types"

/** Stores whose signed-in session benefits from a periodic normal page load. */
export const KEEP_WARM_STORES: StoreId[] = ["target"]

export interface KeepWarmAccount {
  id: string
  label: string
  store: StoreId
  hasSession: boolean
}

export interface KeepWarmDeps {
  settings: () => { keepWarm?: boolean; keepWarmMin?: number }
  accounts: () => KeepWarmAccount[]
  /** True while a task is using this account; keep-warm never competes with a checkout. */
  busy: (accountId: string) => boolean
  warm: (accountId: string) => Promise<{ expired: boolean; detail: string; challenged?: boolean }>
  log: (message: string) => void
  /** A check showed up: tell the person instead of retrying. */
  alert: (account: KeepWarmAccount, message: string) => void
  random?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** Interval with ±25% jitter so refreshes never land on a fixed beat. */
export function nextWarmDelay(minutes: number, random: () => number = Math.random): number {
  const base = Math.min(120, Math.max(10, minutes)) * 60_000
  return Math.round(base * (0.75 + 0.5 * random()))
}

/**
 * 0.2.40: keeps the person's own signed-in Target session warm between checkouts with one
 * low-rate, normal page load per account per interval. It never touches a bot check: if one
 * appears, that account is paused from keep-warm and the person is alerted.
 */
export class KeepWarm {
  private timer: unknown = null
  private running = false
  /** Accounts that hit a check. They stay out until the person turns keep-warm off and on, or restarts. */
  readonly stopped = new Set<string>()

  constructor(private readonly deps: KeepWarmDeps) {}

  start(): void {
    this.schedule()
  }

  stop(): void {
    if (this.timer !== null) (this.deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)))(this.timer)
    this.timer = null
  }

  /** Settings changed: re-arm with the new interval; turning it off clears the stopped list. */
  reconfigure(): void {
    if (this.deps.settings().keepWarm !== true) this.stopped.clear()
    this.stop()
    this.schedule()
  }

  private schedule(): void {
    const settings = this.deps.settings()
    if (settings.keepWarm !== true) return
    const delay = nextWarmDelay(settings.keepWarmMin ?? 25, this.deps.random)
    const set = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.timer = set(() => {
      this.timer = null
      void this.tick().finally(() => this.schedule())
    }, delay)
  }

  /** One pass: each eligible account gets at most one page load, one after another. */
  async tick(): Promise<void> {
    if (this.running || this.deps.settings().keepWarm !== true) return
    this.running = true
    try {
      for (const account of this.deps.accounts()) {
        if (!KEEP_WARM_STORES.includes(account.store) || !account.hasSession) continue
        if (this.stopped.has(account.id)) continue
        if (this.deps.busy(account.id)) {
          this.deps.log(`Keep-warm skipped ${account.label}: a task is using it.`)
          continue
        }
        try {
          const result = await this.deps.warm(account.id)
          if (result.challenged) {
            this.stopped.add(account.id)
            this.deps.log(`Keep-warm stopped for ${account.label}: the store showed a check.`)
            this.deps.alert(account, `${account.label}: Target showed a check during keep-warm. Keep-warm is paused for this account. Open the account browser and clear it yourself.`)
            continue
          }
          if (result.expired) {
            this.stopped.add(account.id)
            this.deps.log(`Keep-warm stopped for ${account.label}: signed out.`)
            this.deps.alert(account, result.detail)
            continue
          }
          this.deps.log(`Keep-warm refreshed ${account.label}.`)
        } catch (err) {
          this.deps.log(`Keep-warm for ${account.label} did not finish: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } finally {
      this.running = false
    }
  }
}
