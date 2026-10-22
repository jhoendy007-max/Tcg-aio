import type { HttpResponse } from "./http"
import { STORE_GAP_MS } from "./polite"
import { storeName } from "../shared/stores"
import type { Settings, StoreId } from "../shared/types"

export interface WatchSnapshot {
  inStock: boolean
  price: number | null
  offerId: string
  soldByRetailer: boolean
  purchasable: boolean
  title: string
  imageUrl?: string
  url?: string
}

export interface MonitorPlace {
  zip: string
  storeId: string
}

export interface DailyWindow {
  start: number
  end: number
}

export interface DropWindow {
  startAt: number
  stopAt: number | null
  enabled: boolean
}

export interface RestockEvent {
  store: StoreId
  sku: string
  at: number
  price: number | null
  title: string
  kind?: "restock" | "price" | "offer" | "oos"
  imageUrl?: string
  url?: string
}

export interface RestockHint {
  store: StoreId
  sku: string
  hourAst: number
  samples: number
  warmupMin: number
  detail: string
}

export interface MonitorSample {
  store: StoreId
  ms: number
  dnsMs?: number
  connectMs?: number
  ttfbMs?: number
  blocked: boolean
  at: number
  proxy?: string
}

export interface MonitorStoreStat {
  store: StoreId
  samples: number
  blocked: number
  blockRate: number
  avgMs: number
  p50Ms: number
  p95Ms: number
}

export interface MonitorStats {
  samples: number
  blocked: number
  blockRate: number
  avgMs: number
  p50Ms: number
  p95Ms: number
  byStore: MonitorStoreStat[]
}

const ZIP_RE = /^\d{5}(?:-\d{4})?$/
const STORE_ID_RE = /^\d{3,8}$/

/** One in-flight read per key. Later callers wait for that read instead of sending another. */
export class MonitorHub {
  private readonly inflight = new Map<string, Promise<unknown>>()

  pending(key: string): boolean {
    return this.inflight.has(key)
  }

  share<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key) as Promise<T> | undefined
    if (existing) return existing
    const pending = load().finally(() => {
      if (this.inflight.get(key) === pending) this.inflight.delete(key)
    })
    this.inflight.set(key, pending)
    return pending
  }
}

export async function sharedValue<T>(
  ctx: { share?: <R>(key: string, load: () => Promise<R>) => Promise<R> },
  key: string,
  load: () => Promise<T>
): Promise<T> {
  if (!ctx.share) return load()
  return ctx.share(key, load)
}

export async function sharedCall(
  ctx: { share?: <T>(key: string, load: () => Promise<T>) => Promise<T> },
  key: string,
  load: () => Promise<HttpResponse>
): Promise<HttpResponse> {
  if (!ctx.share) return load()
  return ctx.share(key, load)
}

export function monitorKey(store: string, sku: string, location: string, proxy?: { host: string; port: number }): string {
  const where = proxy ? `${proxy.host}:${proxy.port}` : "direct"
  return `${store}:${sku}:${location}:${where}`
}

const monitorStrikes = new Map<string, number>()

export function noteMonitorStrike(taskId: string): number {
  const next = (monitorStrikes.get(taskId) ?? 0) + 1
  monitorStrikes.set(taskId, next)
  return next
}

export function clearMonitorStrike(taskId: string): void {
  monitorStrikes.delete(taskId)
}

export function monitorStrike(taskId: string): number {
  return monitorStrikes.get(taskId) ?? 0
}

export function resetMonitorStrikes(): void {
  monitorStrikes.clear()
}

/** Exponential wait after a proxy block. The ceiling is the caller's cap, and never more than a minute. */
export function monitorBlockDelay(attempt: number, capMs: number): number {
  const cap = Math.max(500, Math.min(60_000, Math.round(Number.isFinite(capMs) ? capMs : 2_000)))
  const exp = Math.min(1_000 * 2 ** Math.min(Math.max(attempt, 1) - 1, 5), cap)
  return Math.max(500, Math.round(exp))
}

export function proxyCount(ctx: { proxy?: unknown; proxies?: readonly unknown[] | undefined }): number {
  if (ctx.proxies?.length) return ctx.proxies.length
  return ctx.proxy ? 1 : 0
}

export function storeBlockLine(storeLabel: string, status: number, count: number): string {
  if (count > 1) return `${storeLabel} blocked this proxy (HTTP ${status}). Trying the next proxy in the group.`
  return `${storeLabel} blocked this proxy (HTTP ${status}). Add more residential proxies to the group or try another one.`
}

/** 403, 412, 429, and 435 through a proxy are a block. Other 5xx stay an HTTP retry. */
export function monitorStatusReason(status: number, hasProxy: boolean, storeLabel = "The store", count = 1): string | null {
  if (status === 403 || status === 412 || status === 429 || status === 435) {
    return hasProxy ? storeBlockLine(storeLabel, status, count) : `Monitor request returned HTTP ${status}. Retrying.`
  }
  if (status >= 500) return `Monitor request returned HTTP ${status}. Retrying.`
  return null
}

export function monitorBlockReason(
  ctx: { proxy?: unknown; proxies?: readonly unknown[] | undefined; task: { store: StoreId } },
  status: number
): string | null {
  return monitorStatusReason(status, Boolean(ctx.proxy), storeName(ctx.task.store), proxyCount(ctx))
}

/** Plain block sentence for an anonymous monitor. Checkout still pauses on a real challenge. */
export function monitorKeepsWatching(
  ctx: { monitorOnly?: boolean; proxy?: unknown; proxies?: readonly unknown[] | undefined; task: { store: StoreId } },
  status: number
): string | null {
  if (!ctx.monitorOnly) return null
  if (status !== 403 && status !== 412 && status !== 429 && status !== 435) return null
  return monitorBlockReason(ctx, status)
}

export function stockCheckLine(host: string, proxy?: { host: string; port: number }): string {
  if (proxy) return `Checking stock at ${host} through proxy ${proxy.host}:${proxy.port}.`
  return `Checking stock at ${host}.`
}

export function noteWatch(
  ctx: { observe?: (snapshot: WatchSnapshot) => void },
  reading: { inStock: boolean; title?: string; price?: number; offerId?: string; seller?: string; imageUrl?: string; url?: string }
): void {
  const seller = (reading.seller ?? "").trim().toLowerCase()
  const namedRetailer = /walmart|target|best buy|amazon\.com|^amazon$|pokemon|crunchyroll|bandai|gamestop|barnes|costco|sam's club|tcgplayer direct/.test(seller)
  ctx.observe?.({
    inStock: reading.inStock,
    price: typeof reading.price === "number" ? reading.price : null,
    offerId: reading.offerId ?? "",
    soldByRetailer: namedRetailer || (!seller && reading.inStock),
    purchasable: reading.inStock,
    title: reading.title ?? "",
    imageUrl: reading.imageUrl || undefined,
    url: reading.url || undefined
  })
}

/** True when the task should stay on the monitor and skip cart. */
export async function holdMonitorOnly(ctx: { monitorOnly?: boolean; log: (level: "info", message: string) => void; sleep: (ms: number) => Promise<void>; settings: { monitorDelayMs: number } }): Promise<boolean> {
  if (!ctx.monitorOnly) return false
  ctx.log("info", "Monitor only. Stock is noted and no cart request is sent.")
  await ctx.sleep(ctx.settings.monitorDelayMs)
  return true
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank] ?? 0
}

export function detectChanges(
  prev: WatchSnapshot | null,
  next: WatchSnapshot,
  flags: { price: boolean; offer: boolean; available: boolean; retailer: boolean }
): string[] {
  if (!prev) return []
  const messages: string[] = []
  const name = next.title || "This item"
  if (flags.price && prev.price !== null && next.price !== null && prev.price !== next.price) {
    messages.push(`${name} price changed from $${prev.price.toFixed(2)} to $${next.price.toFixed(2)}.`)
  }
  if (flags.offer && prev.offerId && next.offerId && prev.offerId !== next.offerId) {
    messages.push(`${name} has a new offer.`)
  }
  if (flags.available && !prev.purchasable && next.purchasable) {
    messages.push(`${name} can be added to cart.`)
  }
  if (flags.retailer && !prev.soldByRetailer && next.soldByRetailer) {
    messages.push(`${name} is now sold by the retailer.`)
  }
  return messages
}

export function parseDropWindows(text: string): DailyWindow[] {
  const windows: DailyWindow[] = []
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(line)
    if (!match) throw new Error("Drop windows use Atlantic Time like 09:00-09:30, one per line.")
    const start = Number(match[1]) * 60 + Number(match[2])
    const end = Number(match[3]) * 60 + Number(match[4])
    if (Number(match[1]) > 23 || Number(match[3]) > 23 || Number(match[2]) > 59 || Number(match[4]) > 59 || start === end) {
      throw new Error("Drop windows use Atlantic Time like 09:00-09:30, one per line.")
    }
    windows.push({ start, end })
  }
  return windows
}

export function astMinutes(now: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Puerto_Rico",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now)
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0")
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0")
  return hour * 60 + minute
}

export function astHour(now: number): number {
  return Math.floor(astMinutes(now) / 60)
}

function covers(minute: number, window: DailyWindow): boolean {
  if (window.start < window.end) return minute >= window.start && minute < window.end
  return minute >= window.start || minute < window.end
}

export function inDropWindow(now: number, daily: DailyWindow[], drops: DropWindow[]): boolean {
  const minute = astMinutes(now)
  if (daily.some((window) => covers(minute, window))) return true
  return drops.some((drop) => {
    if (!drop.enabled) return false
    const end = drop.stopAt && drop.stopAt > drop.startAt ? drop.stopAt : drop.startAt + 20 * 60_000
    return now >= drop.startAt - 2 * 60_000 && now < end
  })
}

/** Fast inside a drop window, the normal delay outside, and never under the store gap. */
export function adaptiveDelay(store: StoreId, now: number, settings: Pick<Settings, "monitorDelayMs" | "monitorFastDelayMs" | "dropWindows">, drops: DropWindow[], random = Math.random()): number {
  let daily: DailyWindow[] = []
  try {
    daily = parseDropWindows(settings.dropWindows)
  } catch {
    daily = []
  }
  const inside = inDropWindow(now, daily, drops)
  const chosen = inside ? settings.monitorFastDelayMs : settings.monitorDelayMs
  const base = Math.max(STORE_GAP_MS[store], chosen)
  const unit = Math.max(0, Math.min(1, random))
  const span = 0.2
  return Math.max(STORE_GAP_MS[store], Math.round(base * (1 - span + unit * span * 2)))
}

export function monitorPlaces(settings: Pick<Settings, "targetZip" | "targetStoreId" | "monitorZips" | "monitorStoreIds">): MonitorPlace[] {
  const zips = unique([settings.targetZip, ...splitList(settings.monitorZips)].map((zip) => zip.trim()).filter((zip) => ZIP_RE.test(zip)))
  const storeIds = unique([settings.targetStoreId, ...splitList(settings.monitorStoreIds)].map((id) => id.trim()).filter((id) => STORE_ID_RE.test(id)))
  const primaryZip = zips[0] || "10001"
  const primaryStore = storeIds[0] || "1881"
  const count = Math.max(zips.length, storeIds.length, 1)
  const places: MonitorPlace[] = []
  for (let index = 0; index < count && places.length < 4; index += 1) {
    places.push({
      zip: zips[index] || primaryZip,
      storeId: storeIds[index] || primaryStore
    })
  }
  return places
}

export function suggestWarmups(events: RestockEvent[] | null | undefined, _now = Date.now()): RestockHint[] {
  const groups = new Map<string, { store: StoreId; sku: string; hour: number; samples: number }>()
  for (const event of Array.isArray(events) ? events.filter((row) => row != null) : []) {
    const hour = astHour(event.at)
    const key = `${event.store}:${event.sku}:${hour}`
    const group = groups.get(key) ?? { store: event.store, sku: event.sku, hour, samples: 0 }
    group.samples += 1
    groups.set(key, group)
  }
  return [...groups.values()]
    .filter((group) => group.samples >= 2)
    .sort((a, b) => b.samples - a.samples || a.sku.localeCompare(b.sku))
    .map((group) => ({
      store: group.store,
      sku: group.sku,
      hourAst: group.hour,
      samples: group.samples,
      warmupMin: 15,
      detail: `${group.sku} restocked ${group.samples} times around ${String(group.hour).padStart(2, "0")}:00 AST. Warm the session 15 minutes before that hour.`
    }))
}

export function summarizeMonitor(samples: MonitorSample[] | null | undefined): MonitorStats {
  const rows = Array.isArray(samples) ? samples.filter((sample) => sample != null) : []
  const byStore = new Map<StoreId, { samples: number; blocked: number; ms: number }>()
  let blocked = 0
  let ms = 0
  for (const sample of rows) {
    blocked += sample.blocked ? 1 : 0
    ms += sample.ms
    const row = byStore.get(sample.store) ?? { samples: 0, blocked: 0, ms: 0 }
    row.samples += 1
    row.blocked += sample.blocked ? 1 : 0
    row.ms += sample.ms
    byStore.set(sample.store, row)
  }
  const total = rows.length
  const all = rows.map((sample) => sample.ms)
  return {
    samples: total,
    blocked,
    blockRate: total ? blocked / total : 0,
    avgMs: total ? Math.round(ms / total) : 0,
    p50Ms: percentile(all, 50),
    p95Ms: percentile(all, 95),
    byStore: [...byStore.entries()].map(([store, row]) => {
      const times = rows.filter((sample) => sample.store === store).map((sample) => sample.ms)
      return {
        store,
        samples: row.samples,
        blocked: row.blocked,
        blockRate: row.samples ? row.blocked / row.samples : 0,
        avgMs: row.samples ? Math.round(row.ms / row.samples) : 0,
        p50Ms: percentile(times, 50),
        p95Ms: percentile(times, 95)
      }
    })
  }
}

function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
