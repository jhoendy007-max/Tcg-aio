import { keywordsAllow } from "./keywords"
import type { RestockSignal } from "./restock-parse"
import type { RestockRule, StoreId } from "../shared/types"

export interface RuleTask {
  id: string
  store: StoreId
  quantity: number
  confirmPurchase: boolean
  testMode: boolean
}

export type RuleDecision =
  | { action: "skip"; reason: string }
  | { action: "start"; taskId: string; testMode: boolean; reason: string }
  | { action: "create"; quantity: number; testMode: boolean; reason: string }

export function decideRestock(input: {
  rule: RestockRule
  signal: RestockSignal
  now: number
  globalTestMode: boolean
  task: RuleTask | null
}): RuleDecision {
  const { rule, signal, now, task } = input
  if (!rule.enabled) return { action: "skip", reason: "Rule is off." }
  if (!signal.inStock) return { action: "skip", reason: "Signal says the item is out of stock." }
  if (rule.store && rule.store !== signal.store) return { action: "skip", reason: "Store does not match." }
  if (!rule.sku && !rule.keywords.trim()) return { action: "skip", reason: "Rule needs a SKU or keywords." }
  if (rule.sku && normalize(rule.sku) !== normalize(signal.sku)) return { action: "skip", reason: "SKU does not match." }
  if (!keywordsAllow(rule.keywords, `${signal.title} ${signal.sku} ${signal.url}`)) return { action: "skip", reason: "Keywords do not match." }
  if (rule.maxPrice !== null) {
    if (signal.price === null) return { action: "skip", reason: "Price cap is set and the signal has no price." }
    if (signal.price > rule.maxPrice) return { action: "skip", reason: `Price ${signal.price} is above the cap ${rule.maxPrice}.` }
  }
  if (rule.lastFiredAt && now - rule.lastFiredAt < rule.cooldownSec * 1000) {
    return { action: "skip", reason: "Cooldown has not elapsed." }
  }
  const testMode = rule.testMode || input.globalTestMode || task?.testMode === true
  if (rule.taskId) {
    if (!task) return { action: "skip", reason: "The template task no longer exists." }
    if (task.store !== signal.store) return { action: "skip", reason: "The template task is for a different store." }
    if (task.quantity > rule.maxQuantity) return { action: "skip", reason: "The template task quantity is above the rule cap." }
    if (!testMode && !task.confirmPurchase) return { action: "skip", reason: "Turn on test mode or confirm a real order on that task." }
    return { action: "start", taskId: task.id, testMode, reason: testMode ? "Starting the template task in test mode." : "Starting the template task." }
  }
  if (!rule.profileId || !rule.accountId) return { action: "skip", reason: "Choose a profile and account, or pick a template task." }
  if (!testMode && !rule.confirmPurchase) return { action: "skip", reason: "Turn on test mode or confirm a real order on this rule." }
  const requested = signal.quantity ?? rule.quantity
  const quantity = Math.min(requested, rule.maxQuantity, rule.quantity, 12)
  if (quantity < 1) return { action: "skip", reason: "Quantity is below 1." }
  return { action: "create", quantity, testMode, reason: testMode ? "Creating a test task." : "Creating a task." }
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}
