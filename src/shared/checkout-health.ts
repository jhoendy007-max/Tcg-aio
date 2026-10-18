import { clientIdOf } from "./clients"
import { sessionFreshness } from "./consistency"
import { isActiveStatus, type Address, type StoreId, type TaskStatus } from "./types"

export type HealthCode =
  | "profile-incomplete"
  | "name-mismatch"
  | "address-mismatch"
  | "limit-client"
  | "limit-address"
  | "limit-card"
  | "duplicate-address"
  | "duplicate-card"
  | "session-cold"
  | "session-out"
  | "decline-task"
  | "decline-recent"

export interface HealthIssue {
  code: HealthCode
  level: "warn" | "block"
  vars?: Record<string, string | number>
}

export interface HealthReport {
  issues: HealthIssue[]
  blocked: boolean
}

export interface HealthProfile {
  id: string
  name: string
  email: string
  phone: string
  cardName: string
  last4: string
  clientId?: string
  shipping: Address
  billing: Address
}

export interface HealthAccount {
  id: string
  clientId?: string
  hasSession: boolean
  sessionState?: "missing" | "saved" | "expired"
  lastWarmAt?: number | null
}

export interface HealthTask {
  id: string
  store: StoreId
  sku: string
  quantity: number
  clientId?: string
  profileId: string
  accountId: string
  kind?: string
  monitorOnly?: boolean
  status: TaskStatus
}

export interface HealthCheckout {
  outcome: string
  store: StoreId
  sku: string
  quantity?: number
  clientId?: string
  profileId?: string
  last4?: string
  at?: number
}

export interface CardDecline {
  taskId: string
  last4: string
  at: number
  store: StoreId
  sku: string
}

export interface HealthWorld {
  profiles: HealthProfile[]
  accounts: HealthAccount[]
  tasks: HealthTask[]
  checkouts: HealthCheckout[]
  declines: CardDecline[]
  now: number
  freshMin: number
  /** When on, warnings other than a same-task decline become blocks. */
  block: boolean
  /** 0 means the per-store SKU count is not capped. */
  skuLimit: number
  declineHoldMin: number
  /** Lines like target:3. Blank uses the default of 3 orders per address. */
  addressOrderLimits: string
  /** Successes before this time do not count toward the address cap. */
  addressWindowStart: number
  /** Store rules stricter than the default. The lower number wins. */
  moduleAddressCaps?: Partial<Record<StoreId, number>>
}

export const DEFAULT_ADDRESS_ORDER_CAP = 3

export interface CheckoutSubject {
  taskId?: string
  store: StoreId
  sku: string
  quantity: number
  profileId?: string
  accountId?: string
  clientId?: string
}

const TEXT = {
  en: {
    "profile-incomplete": "The profile is missing a name, email, phone, or a complete shipping or billing address.",
    "name-mismatch": "The profile name or the name on the card does not match the shipping name.",
    "address-mismatch": "The shipping address and the billing address are different.",
    "limit-client": "This client already has {used} of this SKU at this store, counting active tasks. The limit is {limit}.",
    "limit-address": "This shipping address already has {used} orders at this store. The limit is {limit}.",
    "limit-card": "Card {last4} already has {used} of this SKU at this store across clients. The limit is {limit}.",
    "duplicate-address": "This shipping address is also saved for another client.",
    "duplicate-card": "Card {last4} is also saved for another client.",
    "session-cold": "The account session is cold. Warm it before checkout.",
    "session-out": "The account is logged out or has no saved session.",
    "decline-task": "Card {last4} was declined on this task. It will not be tried again.",
    "decline-recent": "Card {last4} was declined recently. Wait or use another card.",
    title: "Checkout check",
    clear: "No checkout warnings.",
    blockLabel: "Block checkout when the check fails",
    blockHint: "Warnings still show when this is off. A declined card is never retried on the same task.",
    limitLabel: "Client SKU limit",
    limitHint: "0 means no cap. Counts successful quantity and active checkout tasks for one client and for one card last4, for one SKU at one store.",
    addressLabel: "Address order limit",
    addressHint: "One line per store, like target:3. Blank uses 3 orders per shipping address at each store during the current drop, or today when no drop is running. A stricter store rule wins. Reaching the cap blocks checkout. The address is compared as saved.",
    holdLabel: "Decline hold (minutes)",
    holdHint: "How long a declined card stays flagged for other tasks. 15–10080. The same task never retries that card."
  },
  es: {
    "profile-incomplete": "Al perfil le falta el nombre, el correo, el teléfono o una dirección de envío o facturación completa.",
    "name-mismatch": "El nombre del perfil o el de la tarjeta no coincide con el nombre de envío.",
    "address-mismatch": "La dirección de envío y la de facturación son distintas.",
    "limit-client": "Este cliente ya tiene {used} de este SKU en esta tienda, contando tareas activas. El límite es {limit}.",
    "limit-address": "Esta dirección de envío ya tiene {used} pedidos en esta tienda. El límite es {limit}.",
    "limit-card": "La tarjeta {last4} ya tiene {used} de este SKU en esta tienda entre clientes. El límite es {limit}.",
    "duplicate-address": "Esta dirección de envío también está guardada para otro cliente.",
    "duplicate-card": "La tarjeta {last4} también está guardada para otro cliente.",
    "session-cold": "La sesión de la cuenta está fría. Caliéntala antes de comprar.",
    "session-out": "La cuenta está desconectada o no tiene sesión guardada.",
    "decline-task": "La tarjeta {last4} fue rechazada en esta tarea. No se volverá a intentar.",
    "decline-recent": "La tarjeta {last4} fue rechazada hace poco. Espera o usa otra tarjeta.",
    title: "Revisión de compra",
    clear: "No hay avisos de compra.",
    blockLabel: "Bloquear la compra si la revisión falla",
    blockHint: "Los avisos se siguen mostrando si esto está apagado. Una tarjeta rechazada no se reintenta en la misma tarea.",
    limitLabel: "Límite de SKU por cliente",
    limitHint: "0 significa sin tope. Cuenta la cantidad exitosa y las tareas de compra activas para un cliente y para los últimos 4 de una tarjeta, de un SKU en una tienda.",
    addressLabel: "Límite de pedidos por dirección",
    addressHint: "Una línea por tienda, como target:3. En blanco usa 3 pedidos por dirección de envío en cada tienda durante el drop actual, o hoy si no hay drop. Gana el tope más estricto de la tienda. Al llegar al tope se bloquea la compra. La dirección se compara tal como está guardada.",
    holdLabel: "Pausa tras rechazo (minutos)",
    holdHint: "Cuánto tiempo una tarjeta rechazada sigue marcada para otras tareas. 15–10080. La misma tarea no reintenta esa tarjeta."
  }
} as const

export type HealthTextKey = keyof typeof TEXT.en

export function healthText(lang: "en" | "es", key: HealthTextKey, vars?: Record<string, string | number>): string {
  return fill(TEXT[lang][key], vars)
}

export function issueText(lang: "en" | "es", issue: HealthIssue): string {
  return healthText(lang, issue.code, issue.vars)
}

export function isCardDecline(detail: string): boolean {
  return /\bdeclin(?:e|ed|es)\b|payment_declined|card_declined/i.test(detail)
}

export function assessCheckout(world: HealthWorld, subject: CheckoutSubject): HealthReport {
  const issues: HealthIssue[] = []
  const profile = world.profiles.find((item) => item.id === subject.profileId)
  if (!profile) issues.push(issue("profile-incomplete", world.block))
  else {
    issues.push(...profileFindings(profile, world.block))
    issues.push(...duplicateFindings(profile, world.profiles))
    issues.push(...limitFindings(world, subject, profile))
    issues.push(...declineFindings(profile.last4, subject.taskId, world))
  }
  if (subject.accountId) {
    const account = world.accounts.find((item) => item.id === subject.accountId)
    const session = sessionFinding(account, world)
    if (session) issues.push(session)
  }
  return pack(issues)
}

export function assessClient(world: HealthWorld, clientId: string): HealthReport {
  const owner = clientIdOf(clientId)
  const tasks = world.tasks.filter((task) => clientIdOf(task.clientId) === owner && task.kind !== "monitor" && task.monitorOnly !== true)
  const issues: HealthIssue[] = []
  const seenProfile = new Set<string>()
  const seenAccount = new Set<string>()
  for (const task of tasks) {
    issues.push(...assessCheckout(world, {
      taskId: task.id,
      store: task.store,
      sku: task.sku,
      quantity: task.quantity,
      profileId: task.profileId,
      accountId: task.accountId,
      clientId: task.clientId
    }).issues)
    seenProfile.add(task.profileId)
    seenAccount.add(task.accountId)
  }
  for (const profile of world.profiles) {
    if (clientIdOf(profile.clientId) !== owner || seenProfile.has(profile.id)) continue
    issues.push(...profileFindings(profile, world.block))
    issues.push(...duplicateFindings(profile, world.profiles))
    issues.push(...declineFindings(profile.last4, undefined, world))
  }
  for (const account of world.accounts) {
    if (clientIdOf(account.clientId) !== owner || seenAccount.has(account.id)) continue
    const session = sessionFinding(account, world)
    if (session) issues.push(session)
  }
  return pack(issues)
}

function profileFindings(profile: HealthProfile, block: boolean): HealthIssue[] {
  const issues: HealthIssue[] = []
  if (incomplete(profile)) issues.push(issue("profile-incomplete", block))
  else if (!personMatches(profile.name, profile.shipping.firstName, profile.shipping.lastName) || !personMatches(profile.cardName, profile.shipping.firstName, profile.shipping.lastName)) {
    issues.push(issue("name-mismatch", block))
  }
  if (!incomplete(profile) && addressKey(profile.shipping) !== addressKey(profile.billing)) {
    issues.push(issue("address-mismatch", block))
  }
  return issues
}

function duplicateFindings(profile: HealthProfile, profiles: HealthProfile[]): HealthIssue[] {
  const issues: HealthIssue[] = []
  const owner = clientIdOf(profile.clientId)
  const place = addressKey(profile.shipping)
  if (place && profiles.some((item) => item.id !== profile.id && addressKey(item.shipping) === place && clientIdOf(item.clientId) !== owner)) {
    issues.push(issue("duplicate-address", false))
  }
  const last4 = cardLast4(profile.last4)
  if (last4 && profiles.some((item) => item.id !== profile.id && item.last4 === last4 && clientIdOf(item.clientId) !== owner)) {
    issues.push(issue("duplicate-card", false, { last4 }))
  }
  return issues
}

function limitFindings(world: HealthWorld, subject: CheckoutSubject, profile: HealthProfile): HealthIssue[] {
  const issues: HealthIssue[] = []
  const place = addressKey(profile.shipping)
  if (place) {
    const cap = addressOrderLimit(subject.store, world)
    const used = addressOrders(world, subject, place)
    if (used + 1 > cap) issues.push(issue("limit-address", true, { used, limit: cap }))
  }
  const limit = Math.round(world.skuLimit)
  const sku = subject.sku.trim()
  if (!limit || limit < 1 || !sku) return issues
  const quantity = clampQty(subject.quantity)
  const owner = clientIdOf(subject.clientId || profile.clientId)
  const clientUsed = count(world, subject, (row) => row.client === owner)
  if (clientUsed + quantity > limit) issues.push(issue("limit-client", world.block, { used: clientUsed, limit }))
  const last4 = cardLast4(profile.last4)
  if (last4) {
    const used = count(world, subject, (row) => row.last4 === last4)
    if (used + quantity > limit) issues.push(issue("limit-card", world.block, { used, limit, last4 }))
  }
  return issues
}

function declineFindings(last4Raw: string, taskId: string | undefined, world: HealthWorld): HealthIssue[] {
  const last4 = cardLast4(last4Raw)
  if (!last4) return []
  const rows = world.declines.filter((row) => row.last4 === last4)
  if (taskId && rows.some((row) => row.taskId === taskId)) return [issue("decline-task", true, { last4 })]
  const holdMs = Math.max(1, world.declineHoldMin) * 60_000
  const recent = rows.some((row) => world.now - row.at <= holdMs)
  if (recent) return [issue("decline-recent", world.block, { last4 })]
  return []
}

function sessionFinding(account: HealthAccount | undefined, world: HealthWorld): HealthIssue | null {
  if (!account) return issue("session-out", world.block)
  const freshness = sessionFreshness({
    hasSession: account.hasSession,
    sessionState: account.sessionState ?? (account.hasSession ? "saved" : "missing"),
    lastWarmAt: account.lastWarmAt ?? null
  }, world.now, world.freshMin)
  if (freshness === "missing" || freshness === "expired") return issue("session-out", world.block)
  if (freshness === "stale" || freshness === "due") return issue("session-cold", world.block)
  return null
}

function count(world: HealthWorld, subject: CheckoutSubject, match: (row: { client: string; place: string; last4: string }) => boolean): number {
  const sku = subject.sku.trim()
  let total = 0
  for (const record of world.checkouts) {
    if (record.outcome !== "success" || record.store !== subject.store || record.sku !== sku) continue
    const profile = world.profiles.find((item) => item.id === record.profileId)
    const row = {
      client: record.clientId ? clientIdOf(record.clientId) : clientIdOf(profile?.clientId),
      place: profile ? addressKey(profile.shipping) : "",
      last4: cardLast4(record.last4 || profile?.last4)
    }
    if (match(row)) total += clampQty(record.quantity ?? 1)
  }
  for (const task of world.tasks) {
    if (task.id === subject.taskId || task.kind === "monitor" || task.monitorOnly) continue
    if (!isActiveStatus(task.status) || task.store !== subject.store || task.sku !== sku) continue
    const profile = world.profiles.find((item) => item.id === task.profileId)
    const row = {
      client: clientIdOf(task.clientId || profile?.clientId),
      place: profile ? addressKey(profile.shipping) : "",
      last4: cardLast4(profile?.last4)
    }
    if (match(row)) total += clampQty(task.quantity)
  }
  return total
}

function incomplete(profile: HealthProfile): boolean {
  if (!profile.name.trim() || !profile.email.includes("@") || digits(profile.phone).length < 10) return true
  return !completeAddress(profile.shipping) || !completeAddress(profile.billing)
}

function completeAddress(address: Address): boolean {
  if (!address.firstName.trim() || !address.lastName.trim() || !address.line1.trim() || !address.city.trim()) return false
  if (!/^[A-Za-z]{2}$/.test(address.state.trim())) return false
  return /^\d{5}(?:-\d{4})?$/.test(address.zip.trim())
}

function personMatches(label: string, first: string, last: string): boolean {
  const name = norm(label)
  const given = norm(first)
  const family = norm(last)
  if (!name || !given || !family) return false
  if (name === `${given} ${family}` || name === `${family} ${given}`) return true
  const parts = new Set(name.split(" "))
  return parts.has(given) && parts.has(family)
}

export function addressKey(address: Address): string {
  return [address.line1, address.line2, address.city, address.state, address.zip].map((part) => normAddress(part ?? "")).filter(Boolean).join("|")
}

export function addressOrderLimit(store: StoreId, world: Pick<HealthWorld, "addressOrderLimits" | "moduleAddressCaps">): number {
  const configured = configuredCap(world.addressOrderLimits, store)
  const base = configured ?? DEFAULT_ADDRESS_ORDER_CAP
  const moduleCap = world.moduleAddressCaps?.[store]
  if (moduleCap && moduleCap > 0 && moduleCap < base) return Math.round(moduleCap)
  return base
}

export function startOfLocalDay(now: number, zone: string): number {
  let used = "UTC"
  const value = zone.trim()
  if (value) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0)
      used = value
    } catch {
      used = "UTC"
    }
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: used,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now)
  const num = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0")
  const elapsed = ((num("hour") * 60 + num("minute")) * 60 + num("second")) * 1000 + (now % 1000)
  return now - elapsed
}

function issue(code: HealthCode, block: boolean, vars?: Record<string, string | number>): HealthIssue {
  const level = code === "decline-task" || block ? "block" : "warn"
  return vars ? { code, level, vars } : { code, level }
}

function pack(issues: HealthIssue[]): HealthReport {
  const seen = new Set<string>()
  const unique: HealthIssue[] = []
  for (const item of issues) {
    const key = `${item.code}:${JSON.stringify(item.vars ?? {})}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  unique.sort((a, b) => Number(b.level === "block") - Number(a.level === "block"))
  return { issues: unique, blocked: unique.some((item) => item.level === "block") }
}

function cardLast4(value: string | undefined): string {
  return value && /^\d{4}$/.test(value) ? value : ""
}

function clampQty(value: number | undefined): number {
  const quantity = Math.round(Number(value) || 1)
  if (!Number.isInteger(quantity) || quantity < 1) return 1
  return Math.min(12, quantity)
}

function digits(value: string): string {
  return value.replace(/\D/g, "")
}

const ADDRESS_WORD: Record<string, string> = {
  street: "st",
  avenue: "ave",
  road: "rd",
  boulevard: "blvd",
  drive: "dr",
  lane: "ln",
  court: "ct",
  place: "pl",
  terrace: "ter",
  parkway: "pkwy",
  circle: "cir",
  highway: "hwy",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  apartment: "apt",
  suite: "ste"
}

function norm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
}

function normAddress(value: string): string {
  return norm(value).split(" ").map((word) => ADDRESS_WORD[word] ?? word).join(" ")
}

function configuredCap(text: string, store: StoreId): number | null {
  for (const raw of text.split(/\n+/)) {
    const match = /^([a-z0-9-]+)\s*[:=]\s*(\d+)$/i.exec(raw.trim())
    if (!match || match[1].toLowerCase() !== store) continue
    const qty = Number(match[2])
    if (qty >= 1 && qty <= 99) return qty
  }
  return null
}

function addressOrders(world: HealthWorld, subject: CheckoutSubject, place: string): number {
  let total = 0
  for (const record of world.checkouts) {
    if (record.outcome !== "success" || record.store !== subject.store) continue
    if (typeof record.at === "number" && record.at < world.addressWindowStart) continue
    const profile = world.profiles.find((item) => item.id === record.profileId)
    if (!profile || addressKey(profile.shipping) !== place) continue
    total += 1
  }
  for (const task of world.tasks) {
    if (task.id === subject.taskId || task.kind === "monitor" || task.monitorOnly) continue
    if (!isActiveStatus(task.status) || task.store !== subject.store) continue
    const profile = world.profiles.find((item) => item.id === task.profileId)
    if (!profile || addressKey(profile.shipping) !== place) continue
    total += 1
  }
  return total
}

function fill(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ""))
}
