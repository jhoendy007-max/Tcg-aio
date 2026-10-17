import type { CheckoutRecord } from "./types"

export interface DayStats {
  count: number
  success: number
  spend: number
  winRate: number
}

export function startOfLocalDay(now: number): number {
  const day = new Date(now)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
}

export function todayCheckoutStats(records: Pick<CheckoutRecord, "at" | "outcome" | "price">[], now: number): DayStats {
  const start = startOfLocalDay(now)
  const rows = records.filter((record) => record.at >= start && record.at < start + 86_400_000)
  const success = rows.filter((record) => record.outcome === "success").length
  const failure = rows.filter((record) => record.outcome === "failure").length
  const paused = rows.filter((record) => record.outcome === "paused").length
  const decided = success + failure + paused
  const spend = rows.reduce((sum, record) => sum + (record.outcome === "success" && record.price ? record.price : 0), 0)
  return { count: rows.length, success, spend, winRate: decided ? success / decided : 0 }
}
