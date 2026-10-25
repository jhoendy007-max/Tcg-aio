import { parseDiscordContent, storeFromName } from "./restock-parse"
import { parseEasternLocal } from "./time"
import type { CalendarDraft, CalendarGame, StoreId, TaskInput } from "../shared/types"

export type { CalendarDraft }

export function parseCalendar(text: string): { events: CalendarDraft[]; skipped: number } | { error: string } {
  const raw = text.trim()
  if (!raw) return { error: "Paste a JSON array or an ICS calendar." }
  if (raw.startsWith("{") || raw.startsWith("[")) return parseJsonFeed(raw)
  if (/BEGIN:VCALENDAR/i.test(raw)) return parseIcs(raw)
  return { error: "Paste a JSON array or an ICS calendar." }
}

export function calendarTaskInputs(input: {
  event: Pick<CalendarDraft, "name" | "store" | "sku">
  accounts: { id: string; store: StoreId; proxyGroupId?: string | null }[]
  profileId: string
  quantity: number
  testMode: boolean
  confirmPurchase: boolean
}): TaskInput[] {
  const group = input.event.name.trim().slice(0, 40)
  return input.accounts
    .filter((account) => account.store === input.event.store)
    .map((account) => ({
      store: input.event.store,
      sku: input.event.sku,
      quantity: input.quantity,
      profileId: input.profileId,
      accountId: account.id,
      proxyGroupId: account.proxyGroupId ?? null,
      monitorProxyGroupId: null,
      confirmPurchase: input.confirmPurchase,
      testMode: input.testMode,
      group
    }))
}

export function gameOf(value: string): CalendarGame | null {
  const text = value.trim().toLowerCase()
  const pokemon = /\bpok[eé]mon\b|\bpokemon\b|\bptcg\b/.test(text)
  const piece = /\bone[\s-]?piece\b|\boptcg\b/.test(text)
  if (pokemon && piece) return null
  if (pokemon) return "pokemon"
  if (piece) return "onepiece"
  if (text === "pokemon" || text === "pokémon") return "pokemon"
  if (text === "onepiece" || text === "one-piece") return "onepiece"
  return null
}

function parseJsonFeed(raw: string): { events: CalendarDraft[]; skipped: number } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: "That JSON could not be read." }
  }
  const rows = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray((parsed as { events?: unknown }).events) ? (parsed as { events: unknown[] }).events : null
  if (!rows) return { error: "JSON needs an array of events, or { events: [] }." }
  const events: CalendarDraft[] = []
  let skipped = 0
  for (const row of rows) {
    const event = oneJson(row)
    if (!event) {
      skipped += 1
      continue
    }
    events.push(event)
  }
  if (!events.length) return { error: "Only Pokémon and One Piece events can be imported." }
  return { events, skipped }
}

function oneJson(value: unknown): CalendarDraft | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const game = gameOf(stringField(record, ["game", "tcg", "category"]))
  if (!game) return null
  const name = stringField(record, ["name", "title", "summary"])
  const startAt = readStart(record.start ?? record.startAt ?? record.date)
  if (!name || startAt === null) return null
  const url = stringField(record, ["url", "link"])
  const fromUrl = url ? parseDiscordContent(url)[0] : undefined
  const store = storeFromName(stringField(record, ["store", "retailer"])) ?? fromUrl?.store ?? null
  const sku = stringField(record, ["sku", "tcin", "pid", "productId"]) || fromUrl?.sku || ""
  if (!store || !sku) return null
  return { game, name: name.slice(0, 80), startAt, store, sku: sku.slice(0, 180), note: stringField(record, ["note", "description"]).slice(0, 180) }
}

function parseIcs(raw: string): { events: CalendarDraft[]; skipped: number } | { error: string } {
  const events: CalendarDraft[] = []
  let skipped = 0
  const unfolded = raw.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "")
  for (const block of unfolded.split(/BEGIN:VEVENT/i).slice(1)) {
    const body = block.split(/END:VEVENT/i)[0] ?? ""
    const summary = icsValue(body, "SUMMARY")
    const categories = icsValue(body, "CATEGORIES")
    const description = icsValue(body, "DESCRIPTION")
    const game = gameOf(`${categories} ${summary} ${description}`)
    const startAt = readIcsStart(icsValue(body, "DTSTART"))
    const url = icsValue(body, "URL")
    const fromUrl = url ? parseDiscordContent(url)[0] : undefined
    const store = storeFromName(fieldAssign(description, "store")) ?? fromUrl?.store ?? null
    const sku = fieldAssign(description, "sku") || fromUrl?.sku || ""
    if (!game || startAt === null || !summary || !store || !sku) {
      skipped += 1
      continue
    }
    events.push({
      game,
      name: summary.slice(0, 80),
      startAt,
      store,
      sku: sku.slice(0, 180),
      note: description.slice(0, 180)
    })
  }
  if (!events.length) return { error: "Only Pokémon and One Piece events can be imported." }
  return { events, skipped }
}

function icsValue(block: string, name: string): string {
  const match = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "im").exec(block)
  return (match?.[1] ?? "").replace(/\\n/g, " ").replace(/\\,/g, ",").trim()
}

function fieldAssign(text: string, key: string): string {
  const match = new RegExp(`(?:^|\\s)${key}\\s*[:=]\\s*(\\S+)`, "i").exec(text)
  return match?.[1]?.trim() ?? ""
}

function readStart(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value > 1e12 ? value : value * 1000
  if (typeof value !== "string" || !value.trim()) return null
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) {
    try {
      return parseEasternLocal(text)
    } catch {
      return null
    }
  }
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) ? parsed : null
}

function readIcsStart(value: string): number | null {
  const stamp = value.includes(":") ? value.slice(value.lastIndexOf(":") + 1) : value
  const zulu = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp)
  if (zulu) return Date.UTC(Number(zulu[1]), Number(zulu[2]) - 1, Number(zulu[3]), Number(zulu[4]), Number(zulu[5]), Number(zulu[6]))
  const local = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(stamp)
  if (local) {
    try {
      return parseEasternLocal(`${local[1]}-${local[2]}-${local[3]}T${local[4]}:${local[5]}`)
    } catch {
      return null
    }
  }
  const day = /^(\d{4})(\d{2})(\d{2})$/.exec(stamp)
  if (!day) return null
  try {
    return parseEasternLocal(`${day[1]}-${day[2]}-${day[3]}T09:00`)
  } catch {
    return null
  }
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number" && Number.isFinite(value)) return String(value)
  }
  return ""
}
