/**
 * Zzz AIO shows and reads drop times in US Eastern Time (America/New_York). It follows
 * daylight saving, so a clock time means EDT in summer and EST in winter. Stored times are
 * epoch milliseconds, which stay valid whatever zone they were typed in.
 */
export const EASTERN_ZONE = "America/New_York"
export { countdown } from "../shared/clock"

function partsIn(ms: number, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-CA", { timeZone: EASTERN_ZONE, hourCycle: "h23", ...options }).formatToParts(ms)
}

/** Offset of Eastern Time from UTC at an instant, in milliseconds (negative). */
export function easternOffsetMs(ms: number): number {
  const parts = partsIn(ms, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0")
  const wall = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"), read("second"))
  return wall - Math.floor(ms / 1000) * 1000
}

/**
 * `YYYY-MM-DDTHH:mm` as an Eastern wall clock to epoch milliseconds.
 * A time that falls in the spring-forward gap lands after the gap. A repeated autumn hour uses the first one.
 */
export function parseEasternLocal(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) throw new Error("Use a date and time in Eastern Time, like 2026-11-13T09:00.")
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error("That date and time is not valid.")
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  // Try both possible offsets (EDT is UTC-4, EST is UTC-5). Prefer the earlier instant when the hour repeats.
  const valid = [wall + 4 * 3_600_000, wall + 5 * 3_600_000].filter((guess) => guess + easternOffsetMs(guess) === wall)
  if (valid.length) return valid[0]
  // Spring-forward gap: the wall clock does not exist. Use the EST reading, which is the first moment after the gap.
  return wall + 5 * 3_600_000
}

export function toEasternInput(ms: number): string {
  const parts = partsIn(ms, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "00"
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`
}

export function formatEastern(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_ZONE,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short"
  }).format(ms)
}

export function easternDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: EASTERN_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms)
}

/** Minutes since local midnight in Eastern Time. */
export function easternMinutes(ms: number): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: EASTERN_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms)
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0")
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0")
  return hour * 60 + minute
}
