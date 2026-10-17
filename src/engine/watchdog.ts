import { zoneParts } from "./limits"
import type { CheckoutRecord, DropSchedule, ProxyScore, PublicAccount, Settings } from "../shared/types"

export function shouldRelaunch(lastCrashAt: number, now: number): boolean {
  return now - lastCrashAt >= 60_000
}

export function reportZone(settings: Settings): string {
  return settings.healthReportZone.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

export function reportDue(lastDay: string, settings: Settings, now: number): boolean {
  const time = settings.healthReportTime.trim()
  if (!/^\d{2}:\d{2}$/.test(time)) return false
  const [hour, minute] = time.split(":").map(Number)
  const zone = reportZone(settings)
  const parts = zoneParts(now, zone)
  const day = `${parts.year}-${parts.month}-${parts.day}`
  if (lastDay === day) return false
  return parts.hour > hour || (parts.hour === hour && parts.minute >= minute)
}

export function healthReport(input: {
  accounts: PublicAccount[]
  scores: ProxyScore[]
  schedules: DropSchedule[]
  checkouts: CheckoutRecord[]
  settings: Settings
  now: number
}): string {
  const saved = input.accounts.filter((account) => account.sessionState === "saved").length
  const expired = input.accounts.filter((account) => account.sessionState === "expired").length
  const missing = input.accounts.filter((account) => account.sessionState === "missing").length
  const benched = input.scores.filter((score) => score.benchedUntil > input.now).length
  const upcoming = input.schedules
    .filter((schedule) => schedule.enabled && schedule.startAt > input.now)
    .sort((a, b) => a.startAt - b.startAt)
    .slice(0, 3)
    .map((schedule) => `${schedule.name} at ${new Date(schedule.startAt).toISOString()}`)
  const zone = input.settings.healthReportZone.trim() || "UTC"
  const yesterday = previousDay(input.now, zone)
  const rows = input.checkouts.filter((record) => dayOf(record.at, zone) === yesterday)
  const success = rows.filter((record) => record.outcome === "success").length
  const failure = rows.filter((record) => record.outcome === "failure").length
  const spend = rows.filter((record) => record.outcome === "success").reduce((total, record) => total + (record.price ?? 0), 0)
  const lines = [
    `Sessions: ${saved} signed in, ${expired} expired, ${missing} missing.`,
    `Proxies: ${benched} benched.`,
    upcoming.length ? `Upcoming: ${upcoming.join("; ")}.` : "Upcoming: no drops scheduled.",
    `Yesterday: ${success} success, ${failure} failure, spend $${spend.toFixed(2)}.`
  ]
  return lines.join(" ")
}

function dayOf(now: number, zone: string): string {
  const parts = zoneParts(now, zone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

function previousDay(now: number, zone: string): string {
  return dayOf(now - 24 * 60 * 60 * 1000, zone)
}
