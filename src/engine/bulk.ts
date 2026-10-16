import { parseSku as parseBandai } from "../stores/bandai/parse"
import { parseAsin } from "../stores/amazon/parse"
import { parseSku as parseBestBuy } from "../stores/bestbuy/parse"
import { parseSku as parseCrunchyroll } from "../stores/crunchyroll/parse"
import { parseSku as parsePokemon } from "../stores/pokemon-center/parse"
import { parseItemId } from "../stores/walmart/parse"
import { parseTcin } from "../shared/tcin"
import { isStoreId } from "../shared/stores"
import type { BulkShared, StoreId, TaskInput } from "../shared/types"

const MAX_TASKS = 50

export function parseBulkTasks(input: BulkShared): { tasks: TaskInput[]; errors: string[] } {
  const lines = input.text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
  const header = lines[0]?.toLowerCase().includes("sku") && lines[0].includes(",") ? splitCells(lines[0]).map((cell) => cell.toLowerCase()) : null
  const body = header ? lines.slice(1) : lines
  const tasks: TaskInput[] = []
  const errors: string[] = []
  for (const line of body) {
    if (tasks.length >= MAX_TASKS) {
      errors.push("Stopped at 50 tasks.")
      break
    }
    if (splitCells(line)[0]?.toLowerCase() === "sku") continue
    const parsed = header ? fromCsv(line, header, input) : fromLine(line, input)
    if ("error" in parsed) errors.push(parsed.error)
    else tasks.push(parsed.task)
  }
  return { tasks, errors }
}

function fromLine(line: string, shared: BulkShared): { task: TaskInput } | { error: string } {
  const cells = line.includes(",") && !/^https?:/i.test(line) ? splitCells(line) : [line]
  const first = cells[0] ?? ""
  const store = storeOf(first) ?? shared.store
  const listed = cells.length > 1 && !storeOf(first)
  const sku = skuOf(store, first) ?? first.trim()
  const quantity = listed ? Number(cells[1]) : shared.quantity
  const group = listed && cells[2] ? cells[2] : shared.group
  return build(shared, store, sku, Number.isFinite(quantity) && quantity > 0 ? quantity : shared.quantity, group || shared.group, line)
}

function fromCsv(line: string, header: string[], shared: BulkShared): { task: TaskInput } | { error: string } {
  const cells = splitCells(line)
  const read = (name: string) => {
    const index = header.indexOf(name)
    return index >= 0 ? cells[index] ?? "" : ""
  }
  const rawStore = read("store")
  const rawSku = read("sku") || read("url") || cells[0] || ""
  const store = rawStore && isStoreId(rawStore) ? rawStore : storeOf(rawSku) ?? shared.store
  const sku = skuOf(store, rawSku) ?? rawSku.trim()
  const quantity = Number(read("quantity") || shared.quantity)
  const group = read("group") || shared.group
  return build(shared, store, sku, quantity, group, line)
}

function build(shared: BulkShared, store: StoreId, sku: string, quantity: number, group: string, line: string): { task: TaskInput } | { error: string } {
  const clean = sku.trim()
  if (!clean) return { error: `Could not read a SKU from "${line.slice(0, 80)}".` }
  const count = Math.round(quantity)
  if (!Number.isInteger(count) || count < 1 || count > 12) return { error: `Quantity for ${clean} must be from 1 to 12.` }
  return {
    task: {
      store,
      sku: clean.slice(0, 240),
      quantity: count,
      profileId: shared.profileId,
      accountId: shared.accountId,
      proxyGroupId: shared.proxyGroupId,
      confirmPurchase: shared.confirmPurchase,
      testMode: shared.testMode,
      group: group.trim().slice(0, 40)
    }
  }
}

function splitCells(line: string): string[] {
  return line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""))
}

function storeOf(value: string): StoreId | null {
  let host = ""
  try {
    host = new URL(value).hostname.toLowerCase()
  } catch {
    return null
  }
  if (host.endsWith("target.com")) return "target"
  if (host.endsWith("walmart.com")) return "walmart"
  if (host.endsWith("bestbuy.com")) return "bestbuy"
  if (host.endsWith("pokemoncenter.com")) return "pokemon-center"
  if (host.endsWith("amazon.com")) return "amazon"
  if (host.endsWith("crunchyroll.com")) return "crunchyroll"
  if (host.endsWith("p-bandai.com") || host.endsWith("premiumbandai.com")) return "bandai"
  return null
}

function skuOf(store: StoreId, value: string): string | null {
  if (store === "target") return parseTcin(value)
  if (store === "walmart") return parseItemId(value)
  if (store === "bestbuy") return parseBestBuy(value)
  if (store === "pokemon-center") return parsePokemon(value)
  if (store === "amazon") return parseAsin(value)
  if (store === "bandai") return parseBandai(value)
  return parseCrunchyroll(value)
}
