import { planQuickPair } from "../shared/quick-setup"
import type { Address, Settings, StoreId } from "../shared/types"
import type { Client, LedgerEntry } from "../shared/clients"
import { clientIdOf } from "../shared/clients"
import { isStoreId } from "../shared/stores"

export interface PhoneClientRow {
  id: string
  name: string
  contact: string
  notes: string
  feeBasis: "success" | "item"
  fee: number
  status: "active" | "paused"
  hasWebhook: boolean
}

export interface PhoneLedgerRow {
  id: string
  at: number
  clientId: string
  clientName: string
  store: StoreId
  sku: string
  product: string
  quantity: number
  price: number | null
  fee: number
  paid: boolean
  paidAt: number | null
}

export interface PhoneDeskSettings {
  addressOrderLimits: string
  hasWebhook: boolean
  testMode: boolean
  clearCartAfterTest: boolean
  sessionWarmup: boolean
  sessionWarmupMin: number
  appName: string
  checkoutHealthBlock: boolean
  declineHoldMin: number
  theme: Settings["theme"]
  accent: Settings["accent"]
}

export interface PhoneProfileDraft {
  id?: string
  name: string
  email: string
  phone: string
  shipping: Address
  billing: Address
  cardName: string
  cardNumber: string
  expMonth: string
  expYear: string
  cvv: string
  cardAction: "keep" | "replace"
  clientId?: string
}

export interface PhoneAccountDraft {
  id?: string
  store: StoreId
  label: string
  username: string
  password: string
  passwordAction: "keep" | "replace" | "clear"
  proxyGroupId: string | null
  clientId?: string
}

export interface PhoneProxyDraft {
  id?: string
  name: string
  text: string
  network: "residential" | "datacenter"
}

export interface PhoneClientDraft {
  id?: string
  name: string
  contact: string
  notes: string
  feeBasis: "success" | "item"
  fee: number
  status: "active" | "paused"
  webhook: string
}

export interface PhoneSettingsDraft {
  addressOrderLimits?: string
  webhook?: string
  webhookAction?: "keep" | "replace" | "clear"
  testMode?: boolean
  clearCartAfterTest?: boolean
  sessionWarmup?: boolean
  sessionWarmupMin?: number
  appName?: string
  checkoutHealthBlock?: boolean
  declineHoldMin?: number
  theme?: Settings["theme"]
  accent?: Settings["accent"]
}

export interface PhoneQuickDraft {
  store: StoreId
  sku: string
  keywords: string
  profileId: string
  accountId: string
  proxyGroupId: string | null
  quantity: number
  testMode: boolean
  confirmPurchase: boolean
  clientId?: string
}

type Req = { req: string; conn: string }

export type DeskMessage =
  | (Req & { type: "profile.save"; profile: PhoneProfileDraft })
  | (Req & { type: "profile.delete"; id: string })
  | (Req & { type: "account.save"; account: PhoneAccountDraft })
  | (Req & { type: "account.delete"; id: string })
  | (Req & { type: "account.warm"; id: string })
  | (Req & { type: "proxy.save"; proxy: PhoneProxyDraft })
  | (Req & { type: "proxy.delete"; id: string })
  | (Req & { type: "client.save"; client: PhoneClientDraft })
  | (Req & { type: "client.delete"; id: string })
  | (Req & { type: "ledger.paid"; clientId: string; ids: string[]; paid: boolean })
  | (Req & { type: "ledger.csv"; clientId: string })
  | (Req & { type: "settings.save"; settings: PhoneSettingsDraft })
  | (Req & { type: "quick.setup"; setup: PhoneQuickDraft })

const DESK_TYPES = new Set([
  "profile.save", "profile.delete", "account.save", "account.delete", "account.warm",
  "proxy.save", "proxy.delete", "client.save", "client.delete", "ledger.paid", "ledger.csv",
  "settings.save", "quick.setup"
])

export function parseDeskMessage(value: { type?: string; req?: string; conn?: string }): DeskMessage | null {
  if (!value.type || !DESK_TYPES.has(value.type)) return null
  const req = value.req ?? ""
  const conn = value.conn ?? ""
  const row = value as Record<string, unknown>
  if (value.type === "profile.delete" || value.type === "account.delete" || value.type === "account.warm" || value.type === "proxy.delete" || value.type === "client.delete") {
    const id = typeof row.id === "string" ? row.id : ""
    if (!id) throw new Error("Choose a saved row.")
    return { type: value.type, req, conn, id }
  }
  if (value.type === "profile.save") return { type: "profile.save", req, conn, profile: parseProfileDraft(row.profile) }
  if (value.type === "account.save") return { type: "account.save", req, conn, account: parseAccountDraft(row.account) }
  if (value.type === "proxy.save") return { type: "proxy.save", req, conn, proxy: parseProxyDraft(row.proxy) }
  if (value.type === "client.save") return { type: "client.save", req, conn, client: parseClientDraft(row.client) }
  if (value.type === "ledger.paid") {
    return {
      type: "ledger.paid",
      req,
      conn,
      clientId: typeof row.clientId === "string" ? row.clientId : "",
      ids: Array.isArray(row.ids) ? row.ids.filter((id): id is string => typeof id === "string").slice(0, 100) : [],
      paid: row.paid !== false
    }
  }
  if (value.type === "ledger.csv") return { type: "ledger.csv", req, conn, clientId: typeof row.clientId === "string" ? row.clientId : "" }
  if (value.type === "settings.save") return { type: "settings.save", req, conn, settings: parseSettingsDraft(row.settings) }
  return { type: "quick.setup", req, conn, setup: parseQuickDraft(row.setup) }
}

export function projectPhoneClient(client: Client): PhoneClientRow {
  return {
    id: client.id,
    name: client.name,
    contact: client.contact,
    notes: client.notes,
    feeBasis: client.feeBasis,
    fee: client.fee,
    status: client.status,
    hasWebhook: Boolean(client.webhook)
  }
}

export function projectPhoneLedger(entry: LedgerEntry): PhoneLedgerRow {
  return {
    id: entry.id,
    at: entry.at,
    clientId: entry.clientId,
    clientName: entry.clientName,
    store: entry.store,
    sku: entry.sku,
    product: entry.product,
    quantity: entry.quantity,
    price: entry.price,
    fee: entry.fee,
    paid: entry.paid,
    paidAt: entry.paidAt
  }
}

export function projectPhoneSettings(settings: Settings): PhoneDeskSettings {
  return {
    addressOrderLimits: settings.addressOrderLimits,
    hasWebhook: Boolean(settings.discordWebhook),
    testMode: settings.testMode,
    clearCartAfterTest: settings.clearCartAfterTest,
    sessionWarmup: settings.sessionWarmup,
    sessionWarmupMin: settings.sessionWarmupMin,
    appName: settings.appName,
    checkoutHealthBlock: settings.checkoutHealthBlock,
    declineHoldMin: settings.declineHoldMin,
    theme: settings.theme,
    accent: settings.accent
  }
}

export function applyPhoneSettings(current: Settings, draft: PhoneSettingsDraft): Settings {
  const next = { ...current }
  if (typeof draft.addressOrderLimits === "string") next.addressOrderLimits = draft.addressOrderLimits
  if (draft.webhookAction === "clear") next.discordWebhook = ""
  if (draft.webhookAction === "replace" && typeof draft.webhook === "string") next.discordWebhook = draft.webhook.trim()
  if (typeof draft.testMode === "boolean") next.testMode = draft.testMode
  if (typeof draft.clearCartAfterTest === "boolean") next.clearCartAfterTest = draft.clearCartAfterTest
  if (typeof draft.sessionWarmup === "boolean") next.sessionWarmup = draft.sessionWarmup
  if (typeof draft.sessionWarmupMin === "number") next.sessionWarmupMin = draft.sessionWarmupMin
  if (typeof draft.appName === "string" && draft.appName.trim()) next.appName = draft.appName.trim().slice(0, 40)
  if (typeof draft.checkoutHealthBlock === "boolean") next.checkoutHealthBlock = draft.checkoutHealthBlock
  if (typeof draft.declineHoldMin === "number") next.declineHoldMin = draft.declineHoldMin
  if (draft.theme === "dark" || draft.theme === "light") next.theme = draft.theme
  if (draft.accent === "gold" || draft.accent === "blue" || draft.accent === "green" || draft.accent === "rose") next.accent = draft.accent
  return next
}

export function quickTasks(draft: PhoneQuickDraft) {
  return planQuickPair({
    store: draft.store,
    sku: draft.sku,
    keywords: draft.keywords,
    profileId: draft.profileId,
    accountId: draft.accountId,
    proxyGroupId: draft.proxyGroupId,
    quantity: draft.quantity,
    testMode: draft.testMode,
    confirmPurchase: draft.confirmPurchase,
    clientId: clientIdOf(draft.clientId)
  })
}

function parseProfileDraft(value: unknown): PhoneProfileDraft {
  const input = object(value, "Profile is invalid.")
  const shipping = address(input.shipping, "Shipping")
  const billing = input.billing ? address(input.billing, "Billing") : shipping
  const name = text(input.name, 80)
  if (!name) throw new Error("Profile name is required.")
  return {
    id: text(input.id, 80) || undefined,
    name,
    email: text(input.email, 180),
    phone: text(input.phone, 40),
    shipping,
    billing,
    cardName: text(input.cardName, 80),
    cardNumber: text(input.cardNumber, 24),
    expMonth: text(input.expMonth, 2),
    expYear: text(input.expYear, 4),
    cvv: text(input.cvv, 4),
    cardAction: input.cardAction === "replace" ? "replace" : "keep",
    clientId: text(input.clientId, 80) || undefined
  }
}

function parseAccountDraft(value: unknown): PhoneAccountDraft {
  const input = object(value, "Account is invalid.")
  if (typeof input.store !== "string" || !isStoreId(input.store)) throw new Error("Choose a store.")
  const label = text(input.label, 80)
  const username = text(input.username, 180)
  if (!label || !username) throw new Error("Account label and email are required.")
  const action = input.passwordAction === "replace" || input.passwordAction === "clear" ? input.passwordAction : "keep"
  return {
    id: text(input.id, 80) || undefined,
    store: input.store,
    label,
    username,
    password: text(input.password, 200),
    passwordAction: action,
    proxyGroupId: text(input.proxyGroupId, 80) || null,
    clientId: text(input.clientId, 80) || undefined
  }
}

function parseProxyDraft(value: unknown): PhoneProxyDraft {
  const input = object(value, "Proxy group is invalid.")
  const name = text(input.name, 80)
  const body = text(input.text, 20_000)
  if (!name || !body) throw new Error("Name the group and paste at least one proxy.")
  return { id: text(input.id, 80) || undefined, name, text: body, network: input.network === "residential" ? "residential" : "datacenter" }
}

function parseClientDraft(value: unknown): PhoneClientDraft {
  const input = object(value, "Client is invalid.")
  const name = text(input.name, 80)
  if (!name) throw new Error("Client name is required.")
  return {
    id: text(input.id, 80) || undefined,
    name,
    contact: text(input.contact, 120),
    notes: text(input.notes, 1000),
    feeBasis: input.feeBasis === "item" ? "item" : "success",
    fee: Number(input.fee ?? 0),
    status: input.status === "paused" ? "paused" : "active",
    webhook: text(input.webhook, 300)
  }
}

function parseSettingsDraft(value: unknown): PhoneSettingsDraft {
  const input = object(value, "Settings are invalid.")
  const draft: PhoneSettingsDraft = {}
  if (typeof input.addressOrderLimits === "string") draft.addressOrderLimits = input.addressOrderLimits.slice(0, 400)
  if (input.webhookAction === "keep" || input.webhookAction === "replace" || input.webhookAction === "clear") draft.webhookAction = input.webhookAction
  if (typeof input.webhook === "string") draft.webhook = input.webhook.slice(0, 300)
  if (typeof input.testMode === "boolean") draft.testMode = input.testMode
  if (typeof input.clearCartAfterTest === "boolean") draft.clearCartAfterTest = input.clearCartAfterTest
  if (typeof input.sessionWarmup === "boolean") draft.sessionWarmup = input.sessionWarmup
  if (typeof input.sessionWarmupMin === "number") draft.sessionWarmupMin = input.sessionWarmupMin
  if (typeof input.appName === "string") draft.appName = input.appName
  if (typeof input.checkoutHealthBlock === "boolean") draft.checkoutHealthBlock = input.checkoutHealthBlock
  if (typeof input.declineHoldMin === "number") draft.declineHoldMin = input.declineHoldMin
  if (input.theme === "dark" || input.theme === "light") draft.theme = input.theme
  if (input.accent === "gold" || input.accent === "blue" || input.accent === "green" || input.accent === "rose") draft.accent = input.accent
  return draft
}

function parseQuickDraft(value: unknown): PhoneQuickDraft {
  const input = object(value, "Quick setup is invalid.")
  if (typeof input.store !== "string" || !isStoreId(input.store)) throw new Error("Choose a store.")
  return {
    store: input.store,
    sku: text(input.sku, 180),
    keywords: text(input.keywords, 200),
    profileId: text(input.profileId, 80),
    accountId: text(input.accountId, 80),
    proxyGroupId: text(input.proxyGroupId, 80) || null,
    quantity: Math.round(Number(input.quantity ?? 1)),
    testMode: input.testMode !== false,
    confirmPurchase: input.confirmPurchase === true,
    clientId: text(input.clientId, 80) || undefined
  }
}

function object(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== "object") throw new Error(error)
  return value as Record<string, unknown>
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

function address(value: unknown, label: string): Address {
  const input = object(value, `${label} address is invalid.`)
  return {
    firstName: text(input.firstName, 40),
    lastName: text(input.lastName, 40),
    line1: text(input.line1, 80),
    line2: text(input.line2, 80),
    city: text(input.city, 40),
    state: text(input.state, 40),
    zip: text(input.zip, 12),
    country: "US"
  }
}
