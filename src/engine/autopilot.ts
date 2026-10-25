import { keywordsAllow } from "./keywords"
import { easternHour, type RestockHint } from "./monitor"
import { allowCheckout, dayKey, storeLimits } from "./limits"
import type { CheckoutRecord, PublicAccount, PublicTask, Settings, StoreId, TaskInput, TaskTemplate } from "../shared/types"
import { isActiveStatus } from "../shared/types"

export interface PilotSignal {
  store: StoreId
  sku: string
  title: string
  price: number | null
}

const COOLDOWN_MS = 60_000

export function matchTemplate(templates: TaskTemplate[], signal: PilotSignal, now: number, globalCap: number): TaskTemplate | null {
  const ranked = templates
    .filter((template) => template.enabled)
    .filter((template) => !template.store || template.store === signal.store)
    .filter((template) => template.accountIds.length > 0 && template.profileIds.length > 0)
    .filter((template) => !template.sku || normalize(template.sku) === normalize(signal.sku))
    .filter((template) => template.sku || keywordsAllow(template.keywords, `${signal.title} ${signal.sku}`))
    .filter((template) => priceAllowed(template.maxPrice, globalCap, signal.price))
    .filter((template) => !template.lastFiredAt || now - template.lastFiredAt >= COOLDOWN_MS)
    .sort((a, b) => Number(Boolean(b.sku)) - Number(Boolean(a.sku)))
  return ranked[0] ?? null
}

export function pickRotation(input: {
  template: TaskTemplate
  accounts: PublicAccount[]
  checkouts: CheckoutRecord[]
  settings: Settings
  store: StoreId
  sku: string
  quantity: number
  price: number | null
  now: number
  profiles?: { id: string; last4: string }[]
}): { ok: true; accountId: string; profileId: string } | { ok: false; reason: string } {
  const limits = storeLimits(input.settings.storePurchaseLimits)
  const zone = input.settings.healthReportZone.trim() || "UTC"
  const today = dayKey(input.now, zone)
  const successes = input.checkouts.filter((record) => record.outcome === "success" && dayKey(record.at, zone) === today)
  const accounts = input.template.accountIds
    .map((id) => input.accounts.find((account) => account.id === id))
    .filter((account): account is PublicAccount => Boolean(account && account.store === input.store))
  if (!accounts.length) return { ok: false, reason: "The template has no account for this store." }
  const open = accounts.filter((account) => underAccountLimits(account, successes, input, limits.get(input.store)))
  if (!open.length) return { ok: false, reason: "Every account on this template is at its purchase limit." }
  open.sort((a, b) => accountUses(successes, a.id) - accountUses(successes, b.id))
  const account = open[0]
  const profiles = input.template.profileIds.filter(Boolean)
  if (!profiles.length) return { ok: false, reason: "The template has no profile." }
  const profileId = [...profiles].sort((a, b) => profileUses(successes, a) - profileUses(successes, b))[0]
  const gate = allowCheckout(input.settings, input.checkouts, {
    store: input.store,
    sku: input.sku,
    accountId: account.id,
    quantity: input.quantity,
    price: input.price,
    now: input.now,
    dropStart: null,
    last4: input.profiles?.find((profile) => profile.id === profileId)?.last4
  })
  if (!gate.ok) return gate
  return { ok: true, accountId: account.id, profileId }
}

export function planTemplateStart(input: {
  template: TaskTemplate
  signal: PilotSignal
  accounts: PublicAccount[]
  checkouts: CheckoutRecord[]
  settings: Settings
  now: number
  profiles?: { id: string; last4: string }[]
}): { ok: true; task: TaskInput; templateId: string } | { ok: false; reason: string } {
  const quantity = input.template.quantity
  const pick = pickRotation({
    template: input.template,
    accounts: input.accounts,
    checkouts: input.checkouts,
    settings: input.settings,
    store: input.signal.store,
    sku: input.signal.sku,
    quantity,
    price: input.signal.price,
    now: input.now,
    profiles: input.profiles
  })
  if (!pick.ok) return pick
  const testMode = input.template.testMode || input.settings.testMode
  if (!testMode && !input.template.confirmPurchase) return { ok: false, reason: "Turn on test mode or confirm a real order on the template." }
  return {
    ok: true,
    templateId: input.template.id,
    task: {
      store: input.signal.store,
      sku: input.signal.sku,
      quantity,
      profileId: pick.profileId,
      accountId: pick.accountId,
      proxyGroupId: input.template.proxyGroupId,
      monitorProxyGroupId: input.template.monitorProxyGroupId,
      confirmPurchase: !testMode && input.template.confirmPurchase,
      testMode,
      group: input.template.group
    }
  }
}

export function learnedDue(input: {
  hints: RestockHint[]
  templates: TaskTemplate[]
  tasks: PublicTask[]
  fired: string[]
  now: number
  globalCap: number
  priceFor?: (hint: RestockHint) => number | null
}): { template: TaskTemplate; hint: RestockHint; key: string }[] {
  const hour = easternHour(input.now)
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(input.now)
  const due: { template: TaskTemplate; hint: RestockHint; key: string }[] = []
  for (const hint of input.hints) {
    if (hint.samples < 2 || hint.hourEt !== hour) continue
    const key = `${hint.store}:${hint.sku}:${day}`
    if (input.fired.includes(key)) continue
    if (input.tasks.some((task) => task.store === hint.store && task.sku === hint.sku && isActiveStatus(task.status))) continue
    const price = input.priceFor?.(hint) ?? null
    const template = matchTemplate(input.templates, { store: hint.store, sku: hint.sku, title: hint.sku, price }, input.now, input.globalCap)
    if (!template) continue
    due.push({ template, hint, key })
  }
  return due
}

export function stuckIds(tasks: PublicTask[], now: number, minutes: number, heals: Record<string, number>, maxHeals = 3): string[] {
  const cutoff = now - minutes * 60_000
  return tasks.filter((task) => {
    if (!isActiveStatus(task.status) || task.status === "in_queue") return false
    if ((heals[task.id] ?? 0) >= maxHeals) return false
    const last = task.logs[task.logs.length - 1]?.ts ?? task.startedAt ?? 0
    return last > 0 && last <= cutoff
  }).map((task) => task.id)
}

export function replacementAccount(accounts: PublicAccount[], currentId: string, store: StoreId, busy: string[]): PublicAccount | null {
  return accounts.find((account) => account.id !== currentId && account.store === store && account.sessionState === "saved" && !busy.includes(account.id)) ?? null
}

export function tasksInterrupted(ids: string[], resume: boolean): string[] {
  return resume ? ids : []
}

function priceAllowed(templateCap: number | null, globalCap: number, price: number | null): boolean {
  const caps = [templateCap, globalCap > 0 ? globalCap : null].filter((cap): cap is number => cap !== null)
  if (!caps.length) return true
  if (price === null) return false
  return price <= Math.min(...caps)
}

function underAccountLimits(account: PublicAccount, successes: CheckoutRecord[], input: { sku: string; quantity: number; settings: Settings }, storeLimit: number | undefined): boolean {
  if (input.settings.maxPerAccount > 0 && accountUses(successes, account.id) >= input.settings.maxPerAccount) return false
  if (storeLimit && storeLimit > 0) {
    const qty = successes
      .filter((record) => record.accountId === account.id && record.sku === input.sku)
      .reduce((total, record) => total + (record.quantity ?? 1), 0)
    if (qty + input.quantity > storeLimit) return false
  }
  return true
}

function accountUses(rows: CheckoutRecord[], accountId: string): number {
  return rows.filter((record) => record.accountId === accountId).length
}

function profileUses(rows: CheckoutRecord[], profileId: string): number {
  return rows.filter((record) => record.profileId === profileId).length
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}
