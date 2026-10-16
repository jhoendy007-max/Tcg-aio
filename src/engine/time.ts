/** Puerto Rico is Atlantic Standard Time, UTC−4, with no daylight-saving shift. */
export const AST_ZONE = "America/Puerto_Rico"
export { countdown } from "../shared/clock"
const AST_OFFSET_MS = 4 * 60 * 60 * 1000

export function parseAstLocal(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim())
  if (!match) throw new Error("Use a date and time in Atlantic Time, like 2026-11-13T09:00.")
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error("That date and time is not valid.")
  }
  return Date.UTC(year, month - 1, day, hour, minute) + AST_OFFSET_MS
}

export function toAstInput(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: AST_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(ms)
  const read = (type: string) => parts.find((part) => part.type === type)?.value ?? "00"
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`
}

export function formatAst(ms: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: AST_ZONE,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short"
  }).format(ms)
}

export function astDay(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: AST_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(ms)
}

