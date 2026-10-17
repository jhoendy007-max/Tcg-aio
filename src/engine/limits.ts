import type { CheckoutRecord, DropSchedule, Settings, StoreId } from "../shared/types"

export class SpendLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SpendLimitError"
  }
}

export interface LimitCheck {
  store: StoreId
  sku: string
  accountId: string
  quantity: number
  price: number | null
  now: number
  dropStart: number | null
  /** Card last four. A per-card cap refuses the order when this is missing. */
  last4?: string
}

export function allowCheckout(settings: Settings, checkouts: CheckoutRecord[], check: LimitCheck): { ok: true } | { ok: false; reason: string } {
  const zone = settings.healthReportZone.trim() || "UTC"
  const today = dayKey(check.now, zone)
  const successes = checkouts.filter((record) => record.outcome === "success")
  const todayRows = successes.filter((record) => dayKey(record.at, zone) === today)
  const price = check.price
  const spend = price === null ? null : round(price * Math.max(1, check.quantity))
  if (settings.dailyBudget > 0) {
    if (spend === null) return { ok: false, reason: "Daily budget is set and this checkout has no price, so it was not sent." }
    const used = sum(todayRows)
    if (used + spend > settings.dailyBudget) {
      return { ok: false, reason: `Daily budget is ${money(settings.dailyBudget)}. Today's spend would be ${money(used + spend)}.` }
    }
  }
  if (settings.dropBudget > 0 && check.dropStart !== null) {
    if (spend === null) return { ok: false, reason: "Drop budget is set and this checkout has no price, so it was not sent." }
    const used = sum(successes.filter((record) => record.at >= check.dropStart!))
    if (used + spend > settings.dropBudget) {
      return { ok: false, reason: `Drop budget is ${money(settings.dropBudget)}. This drop would reach ${money(used + spend)}.` }
    }
  }
  if (settings.maxPerSku > 0) {
    const qty = todayRows.filter((record) => record.sku === check.sku).reduce((total, record) => total + (record.quantity ?? 1), 0)
    if (qty + check.quantity > settings.maxPerSku) {
      return { ok: false, reason: `SKU limit is ${settings.maxPerSku} today. This SKU already has ${qty}.` }
    }
  }
  if (settings.maxPerAccount > 0) {
    const qty = todayRows.filter((record) => record.accountId === check.accountId).length
    if (qty + 1 > settings.maxPerAccount) {
      return { ok: false, reason: `Account limit is ${settings.maxPerAccount} orders today. This account already has ${qty}.` }
    }
  }
  if (settings.accountDailySpend > 0) {
    if (spend === null) return { ok: false, reason: "Account daily spend is set and this checkout has no price, so the order was not placed." }
    const used = sum(todayRows.filter((record) => record.accountId === check.accountId))
    if (used + spend > settings.accountDailySpend) {
      return { ok: false, reason: `Account daily spend is ${money(settings.accountDailySpend)}. This account would reach ${money(used + spend)}, so the order was not placed.` }
    }
  }
  const last4 = cardLast4(check.last4)
  if (settings.cardDailySpend > 0 || settings.cardDailyOrders > 0) {
    if (!last4) return { ok: false, reason: "A per-card limit is set and this profile has no card last four, so the order was not placed." }
  }
  if (settings.cardDailySpend > 0 && last4) {
    if (spend === null) return { ok: false, reason: "Card daily spend is set and this checkout has no price, so the order was not placed." }
    const used = sum(todayRows.filter((record) => record.last4 === last4))
    if (used + spend > settings.cardDailySpend) {
      return { ok: false, reason: `Card ${last4} daily spend is ${money(settings.cardDailySpend)}. It would reach ${money(used + spend)}, so the order was not placed.` }
    }
  }
  if (settings.cardDailyOrders > 0 && last4) {
    const qty = todayRows.filter((record) => record.last4 === last4).length
    if (qty + 1 > settings.cardDailyOrders) {
      return { ok: false, reason: `Card ${last4} is limited to ${settings.cardDailyOrders} orders today. It already has ${qty}, so the order was not placed.` }
    }
  }
  const storeLimit = storeLimits(settings.storePurchaseLimits).get(check.store)
  if (storeLimit && storeLimit > 0) {
    const qty = todayRows
      .filter((record) => record.store === check.store && record.sku === check.sku && record.accountId === check.accountId)
      .reduce((total, record) => total + (record.quantity ?? 1), 0)
    if (qty + check.quantity > storeLimit) {
      return { ok: false, reason: `${check.store} allows ${storeLimit} of this SKU per account today. This account already has ${qty}.` }
    }
  }
  return { ok: true }
}

export function activeDropStart(schedules: DropSchedule[], now: number): number | null {
  const live = schedules.filter((schedule) => schedule.enabled && (schedule.phase === "started" || schedule.phase === "warming") && now >= schedule.startAt && (schedule.stopAt === null || now <= schedule.stopAt))
  if (!live.length) return null
  return Math.min(...live.map((schedule) => schedule.startAt))
}

export function storeLimits(text: string): Map<StoreId, number> {
  const map = new Map<StoreId, number>()
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^([a-z0-9-]+)\s*[:=]\s*(\d+)$/i.exec(line)
    if (!match) continue
    const qty = Number(match[2])
    if (qty > 0 && qty <= 99) map.set(match[1].toLowerCase() as StoreId, qty)
  }
  return map
}

export function dayKey(now: number, zone: string): string {
  const parts = zoneParts(now, zone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

export function zoneParts(now: number, zone: string): { year: string; month: string; day: string; hour: number; minute: number } {
  const used = safeZone(zone)
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: used,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now)
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "0"
  return { year: read("year"), month: read("month"), day: read("day"), hour: Number(read("hour")), minute: Number(read("minute")) }
}

export function safeZone(zone: string): string {
  const value = zone.trim()
  if (!value) return "UTC"
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value }).format(0)
    return value
  } catch {
    return "UTC"
  }
}

function sum(rows: CheckoutRecord[]): number {
  return round(rows.reduce((total, record) => total + (record.price ?? 0), 0))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

function cardLast4(value: string | undefined): string {
  return value && /^\d{4}$/.test(value) ? value : ""
}
