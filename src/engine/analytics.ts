import { astDay } from "./time"
import { storeName } from "../shared/stores"
import type { AnalyticsReport, CheckoutOutcome, CheckoutRecord, ProductAnalytics, StoreAnalytics, StoreId, TimelinePoint } from "../shared/types"

export function priceFromDetail(detail: string): number | null {
  const match = detail.match(/\$\s*(\d{1,6}(?:\.\d{1,2})?)/)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

export function summarize(records: CheckoutRecord[]): AnalyticsReport {
  const byStore = new Map<StoreId, StoreAnalytics>()
  const byProduct = new Map<string, ProductAnalytics>()
  const days = new Map<string, TimelinePoint>()
  let success = 0
  let failure = 0
  let paused = 0
  let tested = 0
  let spend = 0
  for (const record of records) {
    if (record.outcome === "success") success += 1
    else if (record.outcome === "failure") failure += 1
    else if (record.outcome === "paused") paused += 1
    else tested += 1
    if (record.outcome === "success" && record.price !== null) spend += record.price
    const store = byStore.get(record.store) ?? { store: record.store, storeName: storeName(record.store), success: 0, failure: 0, paused: 0, tested: 0, spend: 0 }
    bump(store, record)
    byStore.set(record.store, store)
    const key = `${record.store}:${record.sku}`
    const product = byProduct.get(key) ?? { store: record.store, sku: record.sku, product: record.product || record.sku, success: 0, failure: 0, paused: 0, spend: 0 }
    if (record.outcome === "success") product.success += 1
    else if (record.outcome === "failure") product.failure += 1
    else if (record.outcome === "paused") product.paused += 1
    if (record.outcome === "success" && record.price !== null) product.spend += record.price
    byProduct.set(key, product)
    if (record.outcome !== "tested") {
      const day = astDay(record.at)
      const point = days.get(day) ?? { day, success: 0, failure: 0, paused: 0 }
      if (record.outcome === "success") point.success += 1
      else if (record.outcome === "failure") point.failure += 1
      else point.paused += 1
      days.set(day, point)
    }
  }
  const decided = success + failure + paused
  return {
    attempts: records.length,
    success,
    failure,
    paused,
    tested,
    winRate: decided ? success / decided : 0,
    spend: Math.round(spend * 100) / 100,
    byStore: [...byStore.values()],
    byProduct: [...byProduct.values()].sort((a, b) => b.success - a.success || a.sku.localeCompare(b.sku)),
    timeline: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    recent: records.slice(0, 40),
    monitor: { samples: 0, blocked: 0, blockRate: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, byStore: [] },
    stockLog: [],
    restockHints: []
  }
}

function bump(row: { success: number; failure: number; paused: number; tested: number; spend: number }, record: CheckoutRecord): void {
  if (record.outcome === "success") row.success += 1
  else if (record.outcome === "failure") row.failure += 1
  else if (record.outcome === "paused") row.paused += 1
  else row.tested += 1
  if (record.outcome === "success" && record.price !== null) row.spend += record.price
}

export function checkoutCsv(records: CheckoutRecord[]): string {
  const lines = ["at,store,sku,product,price,outcome,profile,orderId,detail"]
  for (const record of records) {
    lines.push([
      new Date(record.at).toISOString(),
      record.store,
      record.sku,
      record.product,
      record.price ?? "",
      record.outcome,
      record.profileName,
      record.orderId ?? "",
      record.detail
    ].map(csvCell).join(","))
  }
  return lines.join("\n")
}

function csvCell(value: string | number): string {
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}

export function isCheckoutOutcome(value: string): value is CheckoutOutcome {
  return value === "success" || value === "failure" || value === "paused" || value === "tested"
}
