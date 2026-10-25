import type { BrowserContext } from "playwright-core"
import type { HttpClient, HttpRequest, HttpResponse } from "../engine/http"
import { clawLaunch, type ClawBrowser } from "./claw-launch"

/** Subset of Playwright's APIRequestContext that the client needs. */
export interface ClawContext {
  request: BrowserContext["request"]
}

export type ClawOpen = (profile: string) => Promise<{ context: ClawContext; close(): Promise<void> }>

export interface ClawHttpOptions {
  /** Live Clawbrowser profiles at once. Extra accounts wait in line. A full browser is heavy. */
  maxLive?: number
  /** Close a profile this long after its last request, so 500 tasks do not keep 500 browsers open. */
  idleMs?: number
}

/** `persist:account-<id>` becomes the profile `acct-<id>`. Monitors share one profile. */
export function profileForPartition(partition?: string): string {
  const match = /^persist:account-(.+)$/.exec(partition ?? "")
  return match ? `acct-${match[1]}` : "monitor"
}

type Opened = { context: ClawContext; close(): Promise<void> }

interface Entry {
  ready: Promise<Opened>
  lastUsed: number
  active: number
  timer?: ReturnType<typeof setTimeout>
}

/**
 * HttpClient that sends every store request through a Clawbrowser profile's
 * cookie jar and network stack. One profile per account, opened on first use and
 * closed when idle or when the live limit is reached. Profile identity and
 * fingerprint belong to Clawbrowser. A proxy is bound to the profile, so
 * `input.proxy` is not used here.
 */
export class ClawHttp implements HttpClient {
  private readonly profiles = new Map<string, Entry>()
  private readonly waiters: Array<() => void> = []
  private readonly capacity: number
  private readonly idleMs: number

  constructor(private readonly open: ClawOpen = defaultOpen, options: ClawHttpOptions = {}) {
    this.capacity = Math.max(1, Math.round(options.maxLive ?? 40))
    this.idleMs = Math.max(0, Math.round(options.idleMs ?? 120_000))
  }

  get live(): number {
    return this.profiles.size
  }

  /** Makes room by closing the least recently used profile that has no request in flight. */
  private evictIdle(): boolean {
    let oldest: string | undefined
    for (const [name, entry] of this.profiles) {
      if (entry.active > 0) continue
      if (oldest === undefined || entry.lastUsed < this.profiles.get(oldest)!.lastUsed) oldest = name
    }
    if (oldest === undefined) return false
    void this.closeProfile(oldest)
    return true
  }

  private async reserve(): Promise<void> {
    while (this.profiles.size >= this.capacity) {
      if (this.evictIdle()) continue
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }

  private async acquire(name: string): Promise<Entry> {
    let entry = this.profiles.get(name)
    if (!entry) {
      await this.reserve()
      entry = this.profiles.get(name)
      if (!entry) {
        const ready = this.open(name)
        entry = { ready, lastUsed: Date.now(), active: 0 }
        this.profiles.set(name, entry)
        const created = entry
        ready.catch(() => {
          if (this.profiles.get(name) === created) this.profiles.delete(name)
          this.wake()
        })
      }
    }
    entry.active += 1
    entry.lastUsed = Date.now()
    this.scheduleIdle(name, entry)
    return entry
  }

  private scheduleIdle(name: string, entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer)
    if (this.idleMs === 0) return
    entry.timer = setTimeout(() => {
      if (this.profiles.get(name) !== entry) return
      if (entry.active > 0 || Date.now() - entry.lastUsed < this.idleMs) return this.scheduleIdle(name, entry)
      void this.closeProfile(name)
    }, this.idleMs)
    entry.timer.unref?.()
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  private async closeProfile(name: string): Promise<void> {
    const entry = this.profiles.get(name)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    this.profiles.delete(name)
    try {
      await (await entry.ready).close()
    } catch {
      // A profile that failed to start has nothing to close.
    } finally {
      this.wake()
    }
  }

  async request(input: HttpRequest): Promise<HttpResponse> {
    const started = Date.now()
    const name = profileForPartition(input.partition)
    const entry = await this.acquire(name)
    try {
      const { context } = await entry.ready
      const res = await context.request.fetch(input.url, {
        method: input.method,
        headers: input.headers,
        data: input.body,
        maxRedirects: input.redirect === "manual" ? 0 : 5,
        timeout: input.timeoutMs ?? 25_000,
        failOnStatusCode: false
      })
      const headers: Record<string, string | string[] | undefined> = {}
      for (const { name: header, value } of res.headersArray()) {
        const key = header.toLowerCase()
        const prev = headers[key]
        headers[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value]
      }
      const body = await res.text()
      const totalMs = Date.now() - started
      return { status: res.status(), headers, body, timing: { dnsMs: 0, connectMs: 0, ttfbMs: totalMs, totalMs } }
    } finally {
      entry.active = Math.max(0, entry.active - 1)
      entry.lastUsed = Date.now()
    }
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.profiles.keys()].map((name) => this.closeProfile(name)))
  }
}

async function defaultOpen(profile: string) {
  const browser: ClawBrowser = await clawLaunch({ profile })
  return { context: browser.context, close: () => browser.close() }
}
