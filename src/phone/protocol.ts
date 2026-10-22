import { gcm } from "@noble/ciphers/aes"
import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha2"
import { bytesToUtf8, randomBytes, utf8ToBytes } from "@noble/hashes/utils"
import { parseDeskMessage } from "./desk"
import { redact } from "../shared/redact"
import { isStoreId, storeName } from "../shared/stores"
import type { StoreRoles } from "../shared/store-defaults"
import type { DeskMessage, PhoneClientRow, PhoneDeskSettings, PhoneLedgerRow } from "./desk"
import type { AlertLog, KeywordWatch, KeywordWatchInput, LogLine, ModuleRecord, PublicAccount, PublicChallenge, PublicProfile, PublicTask, RestockRule, RestockRuleInput, StartMode, StoreHealth, StoreId, StoreInfo, TaskKind, TaskOverrides, TaskStatus } from "../shared/types"

export const PHONE_PROTOCOL = 1
export const INVITE_TTL_MS = 3 * 60 * 1000
export const FRAME_SKEW_MS = 120_000
const LOG_LIMIT = 40

const PAIR_INFO = utf8ToBytes("tcgaio-pair-v1")
const SESSION_INFO = utf8ToBytes("tcgaio-session-v1")

export interface PairingPayload {
  v: 1
  pcId: string
  name: string
  host: string
  port: number
  secret: string
  relay?: string
  relayChannel?: string
  relayToken?: string
}

export interface PhoneProfile {
  id: string
  name: string
  email: string
  phone: string
  shipping: PublicProfile["shipping"]
  billing: PublicProfile["billing"]
  cardName: string
  last4: string
  expMonth: string
  expYear: string
  city: string
  state: string
  clientId?: string
}

export interface PhoneAccount {
  id: string
  store: StoreId
  label: string
  usernameMasked: string
  hasPassword: boolean
  hasSession: boolean
  sessionState?: "missing" | "saved" | "expired"
  lastWarmAt?: number | null
  clientId?: string
  proxyGroupId?: string | null
}

export interface PhoneProxyGroup {
  id: string
  name: string
  count: number
}

export interface PhoneDevice {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
}

export interface PhoneStatus {
  listening: boolean
  host: string
  port: number
  relay: string
  pcName: string
  devices: PhoneDevice[]
  inviteExpiresAt: number | null
}

export interface PhoneInvite extends PhoneStatus {
  text: string
  qrDataUrl: string
}

export interface PhoneTask {
  id: string
  store: StoreId
  storeName: string
  sku: string
  quantity: number
  profileId: string
  profileName: string
  accountId: string
  accountLabel: string
  proxyGroupId: string | null
  proxyGroupName: string | null
  confirmPurchase: boolean
  testMode: boolean
  group: string
  imageUrl?: string
  monitorOnly?: boolean
  kind?: TaskKind
  keywords?: string
  priceCap?: number | null
  webhook?: string
  activeHours?: string
  linkedCheckoutIds?: string[]
  checkoutDelayMs?: number | null
  maxPrice?: number | null
  startMode?: StartMode
  linkedMonitorId?: string | null
  jitterPct?: number | null
  monitorProxyGroupId?: string | null
  overrides?: TaskOverrides
  monitorMs?: number
  detectToCartMs?: number
  status: TaskStatus
  detail: string
  logs: LogLine[]
  createdAt: number
}

export interface PhoneSchedule {
  id: string
  name: string
  enabled: boolean
  startAt: number
  stopAt: number | null
  warmupMin: number
  phase: string
  taskCount: number
  group: string
}

export interface PhoneAnalytics {
  attempts: number
  success: number
  failure: number
  paused: number
  tested: number
  winRate: number
  spend: number
  byStore: { store: StoreId; storeName: string; success: number; failure: number; paused: number; spend: number }[]
  recent: { at: number; storeName: string; sku: string; outcome: string; price: number | null }[]
  monitorSamples?: number
  monitorBlocked?: number
  monitorBlockRate?: number
  monitorAvgMs?: number
  monitorP50Ms?: number
  monitorP95Ms?: number
}

export interface PhoneUpdates {
  desktopVersion: string | null
  phoneVersion: string | null
  notes: string
}

export interface PhoneKeeper {
  enabled: boolean
  intervalMin: number
  saved: number
  expired: number
}

export interface PhoneMailbox {
  id: string
  name: string
  user: string
  provider: "gmail" | "outlook" | "icloud" | "yahoo" | "custom"
  host: string
  port: number
  secure: boolean
  mailbox: string
  enabled: boolean
  auth: "password" | "xoauth2"
  orders: boolean
  alerts: boolean
  codes: boolean
  lastError: string
}

export interface PhoneMailDraft {
  id?: string
  user: string
  provider: PhoneMailbox["provider"]
  host: string
  port: number
  secure: boolean
  mailbox: string
  password: string
  orders: boolean
  alerts: boolean
  codes: boolean
}

export interface PhoneImap {
  accounts: number
  enabled: number
  ready: number
  lastError: string
  mailboxes?: PhoneMailbox[]
  googleSignIn?: boolean
  microsoftSignIn?: boolean
}

export interface PhoneModuleGlobals {
  monitorDelayMs: number
  sessionWarmupMin: number
  blockRetries: number
  testMode: boolean
  monitorZips: string
  monitorStoreIds: string
  targetZip: string
  targetStoreId: string
}

export interface PhoneSnapshot {
  pcName: string
  testMode: boolean
  clearCartAfterTest: boolean
  tasks: PhoneTask[]
  profiles: PhoneProfile[]
  accounts: PhoneAccount[]
  proxyGroups: PhoneProxyGroup[]
  stores: StoreInfo[]
  alerts: PhoneAlerts
  schedules: PhoneSchedule[]
  analytics: PhoneAnalytics
  updates: PhoneUpdates
  keeper: PhoneKeeper
  imap?: PhoneImap
  language?: "en" | "es"
  modules?: Partial<Record<StoreId, ModuleRecord>>
  moduleGlobals?: PhoneModuleGlobals
  autopilot?: boolean
  brand?: { appName: string; theme: "dark" | "light"; accent: "gold" | "blue" | "green" | "rose"; successSound: boolean }
  clients?: PhoneClientRow[]
  ledger?: PhoneLedgerRow[]
  desk?: PhoneDeskSettings
  /** Per-store monitor and checkout defaults. Missing means the built-in pace. */
  storeRoles?: StoreRoles
  /** True when this paired PC has a valid license. The phone does not use its own seat. */
  licenseOk?: boolean
  /** True when the paired PC is signed in and still waiting for a license. */
  accountPending?: boolean
}

/** Challenge handoff for the paired phone. The cookie is only on this message. */
export interface PhoneChallenge extends PublicChallenge {
  cookie: string
}

export interface PhoneNotice {
  kind: "success" | "failure" | "paused" | "tested" | "alert" | "challenge" | "session" | "drop" | "health"
  storeName: string
  sku: string
  profileName: string
  detail: string
  orderId?: string
  price?: number | null
  url?: string
  imageUrl?: string
  inStock?: boolean
  ts: number
}

export interface PhoneAlerts {
  localUrl: string
  relayUrl: string
  discordWatch: boolean
  hasBot: boolean
  channelId: string
  rules: RestockRule[]
  watches: KeywordWatch[]
  log: AlertLog[]
}

export const EMPTY_ALERTS: PhoneAlerts = {
  localUrl: "",
  relayUrl: "",
  discordWatch: false,
  hasBot: false,
  channelId: "",
  rules: [],
  watches: [],
  log: []
}

export const EMPTY_ANALYTICS: PhoneAnalytics = {
  attempts: 0,
  success: 0,
  failure: 0,
  paused: 0,
  tested: 0,
  winRate: 0,
  spend: 0,
  byStore: [],
  recent: []
}

export const EMPTY_UPDATES: PhoneUpdates = { desktopVersion: null, phoneVersion: null, notes: "" }

export const EMPTY_KEEPER: PhoneKeeper = { enabled: false, intervalMin: 30, saved: 0, expired: 0 }

export interface PhoneTaskDraft {
  id?: string
  store: StoreId
  sku: string
  quantity: number
  profileId: string
  accountId: string
  proxyGroupId: string | null
  confirmPurchase: boolean
  testMode?: boolean
  group?: string
  kind?: TaskKind
  keywords?: string
  priceCap?: number | null
  webhook?: string
  activeHours?: string
  linkedCheckoutIds?: string[]
  checkoutDelayMs?: number | null
  maxPrice?: number | null
  startMode?: StartMode
  linkedMonitorId?: string | null
  jitterPct?: number | null
  monitorProxyGroupId?: string | null
  overrides?: TaskOverrides
}

export type ClientMessage =
  | { type: "pair"; deviceName: string }
  | { type: "hello" }
  | { type: "sync"; req: string; conn: string }
  | { type: "task.start"; req: string; conn: string; taskId: string }
  | { type: "task.test"; req: string; conn: string; taskId: string }
  | { type: "health.check"; req: string; conn: string; proxyGroupId: string | null }
  | { type: "task.stop"; req: string; conn: string; taskId: string }
  | { type: "task.startAll"; req: string; conn: string }
  | { type: "task.stopAll"; req: string; conn: string }
  | { type: "task.pauseAll"; req: string; conn: string }
  | { type: "autopilot.set"; req: string; conn: string; enabled: boolean }
  | { type: "language.set"; req: string; conn: string; language: "en" | "es" }
  | { type: "mail.save"; req: string; conn: string; mailbox: PhoneMailDraft }
  | { type: "mail.delete"; req: string; conn: string; id: string }
  | { type: "mail.oauth"; req: string; conn: string; provider: "gmail" | "outlook"; user: string }
  | { type: "module.save"; req: string; conn: string; store: StoreId; record: ModuleRecord }
  | { type: "module.reset"; req: string; conn: string; store: StoreId }
  | { type: "module.import"; req: string; conn: string; text: string }
  | { type: "task.save"; req: string; conn: string; task: PhoneTaskDraft }
  | { type: "task.delete"; req: string; conn: string; taskId: string }
  | { type: "rule.save"; req: string; conn: string; rule: RestockRuleInput }
  | { type: "rule.delete"; req: string; conn: string; ruleId: string }
  | { type: "rule.toggle"; req: string; conn: string; ruleId: string; enabled: boolean }
  | { type: "watch.save"; req: string; conn: string; watch: KeywordWatchInput }
  | { type: "watch.delete"; req: string; conn: string; watchId: string }
  | { type: "watch.toggle"; req: string; conn: string; watchId: string; enabled: boolean }
  | { type: "watch.resume"; req: string; conn: string; watchId: string }
  | { type: "challenge.open"; req: string; conn: string }
  | { type: "challenge.done"; req: string; conn: string }
  | { type: "challenge.dismiss"; req: string; conn: string }
  | { type: "challenge.submit"; req: string; conn: string; cookie: string }
  | { type: "account.login"; req: string; conn: string; accountId: string }
  | { type: "task.bulk"; req: string; conn: string; text: string; store: StoreId; quantity: number; profileId: string; accountId: string; proxyGroupId: string | null; confirmPurchase: boolean; testMode: boolean; group: string }
  | { type: "task.duplicate"; req: string; conn: string; taskId: string }
  | { type: "schedule.save"; req: string; conn: string; name: string; startAt: string; stopAt: string; warmupMin: number; group: string; taskIds: string[] }
  | { type: "schedule.delete"; req: string; conn: string; scheduleId: string }
  | { type: "analytics.csv"; req: string; conn: string }
  | { type: "vault.link"; req: string; conn: string; accountId: string; twoWay: boolean }
  | { type: "vault.unlink"; req: string; conn: string; accountId: string }
  | { type: "vault.push"; req: string; conn: string; accountId: string; cookie: string; expiresAt: number | null }
  | { type: "vault.pull"; req: string; conn: string; accountId: string }
  | DeskMessage

export type ServerMessage =
  | { type: "paired"; token: string; deviceId: string; pcName: string; relayToken?: string; relay?: string; relayChannel?: string }
  | { type: "presence"; online: true; pcName: string }
  | { type: "snapshot"; conn: string; snapshot: PhoneSnapshot }
  | { type: "task"; task: PhoneTask }
  | { type: "task.deleted"; id: string }
  | { type: "notice"; notice: PhoneNotice }
  | { type: "alerts"; alerts: PhoneAlerts }
  | { type: "challenge"; challenge: PhoneChallenge | null }
  | { type: "result"; req: string; ok: true; started?: string[]; errors?: { id: string; error: string }[]; task?: PhoneTask; health?: StoreHealth[]; alerts?: PhoneAlerts; csv?: string; created?: number; cookie?: string }
  | { type: "vault.session"; accountId: string; cookie: string }
  | { type: "result"; req: string; ok: false; error: string }
  | { type: "error"; error: string }

export interface SealedFrame {
  v: 1
  mode: "pair" | "session"
  pcId: string
  n: string
  c: string
  rid?: string
}

export function randomSecret(): string {
  return bytesToB64(randomBytes(32))
}

export function randomId(): string {
  const bytes = randomBytes(16)
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

export function pairKey(secret: string): Uint8Array {
  return derive(secret, PAIR_INFO)
}

export function sessionKey(token: string): Uint8Array {
  return derive(token, SESSION_INFO)
}

export function seal(key: Uint8Array, message: ClientMessage | ServerMessage, header: { mode: SealedFrame["mode"]; pcId: string; rid?: string }): string {
  const nonce = randomBytes(12)
  const plain = utf8ToBytes(JSON.stringify({ t: Date.now(), m: message }))
  const boxed = gcm(key, nonce).encrypt(plain)
  const frame: SealedFrame = {
    v: 1,
    mode: header.mode,
    pcId: header.pcId,
    n: bytesToB64(nonce),
    c: bytesToB64(boxed),
    ...(header.rid ? { rid: header.rid } : {})
  }
  return JSON.stringify(frame)
}

export function openFrame(key: Uint8Array, frame: SealedFrame, now: number, seen: Set<string>): ClientMessage | ServerMessage {
  if (seen.has(frame.n)) throw new Error("Rejected a replayed phone frame.")
  const plain = gcm(key, b64ToBytes(frame.n)).decrypt(b64ToBytes(frame.c))
  const parsed = JSON.parse(bytesToUtf8(plain)) as { t?: unknown; m?: unknown }
  if (typeof parsed.t !== "number" || Math.abs(now - parsed.t) > FRAME_SKEW_MS) throw new Error("Phone frame is outside the time window.")
  seen.add(frame.n)
  return parsed.m as ClientMessage | ServerMessage
}

export function parseFrame(text: string): SealedFrame {
  const value = JSON.parse(text) as Partial<SealedFrame>
  if (value.v !== 1 || (value.mode !== "pair" && value.mode !== "session")) throw new Error("Unsupported phone frame.")
  if (typeof value.pcId !== "string" || typeof value.n !== "string" || typeof value.c !== "string") throw new Error("Unsupported phone frame.")
  return {
    v: 1,
    mode: value.mode,
    pcId: value.pcId,
    n: value.n,
    c: value.c,
    rid: typeof value.rid === "string" && value.rid.length > 0 && value.rid.length < 80 ? value.rid : undefined
  }
}

export function encodePairingPayload(payload: PairingPayload): string {
  return JSON.stringify(payload)
}

export function parsePairingPayload(text: string): PairingPayload {
  let value: Partial<PairingPayload>
  try {
    value = JSON.parse(text) as Partial<PairingPayload>
  } catch {
    throw new Error("That QR code is not a TCGAIO pairing code.")
  }
  if (value.v !== 1) throw new Error("This pairing code is from a different TCGAIO version.")
  if (!value.pcId || !/^[0-9a-f-]{36}$/i.test(value.pcId)) throw new Error("Pairing code is missing the PC id.")
  if (!value.name || typeof value.name !== "string") throw new Error("Pairing code is missing the PC name.")
  if (!value.host || !/^[A-Za-z0-9._-]+$/.test(value.host)) throw new Error("Pairing code has an invalid address.")
  if (!Number.isInteger(value.port) || value.port! < 1 || value.port! > 65535) throw new Error("Pairing code has an invalid port.")
  if (!value.secret || b64ToBytes(value.secret).length !== 32) throw new Error("Pairing code is missing its one-time secret.")
  const payload: PairingPayload = {
    v: 1,
    pcId: value.pcId,
    name: value.name.slice(0, 60),
    host: value.host,
    port: value.port!,
    secret: value.secret
  }
  if (typeof value.relay === "string" && value.relay.trim()) {
    const relay = value.relay.trim()
    if (!/^wss?:\/\/[^\s]+$/i.test(relay)) throw new Error("Pairing code has an invalid relay.")
    payload.relay = relay
  }
  if (typeof value.relayChannel === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value.relayChannel)) payload.relayChannel = value.relayChannel
  if (typeof value.relayToken === "string" && /^[A-Za-z0-9_-]{20,200}$/.test(value.relayToken)) payload.relayToken = value.relayToken
  return payload
}

export function cleanDeviceName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40)
  if (!cleaned) throw new Error("Name this phone before pairing.")
  return cleaned
}

export function maskUsername(username: string): string {
  const trimmed = username.trim()
  const at = trimmed.indexOf("@")
  if (at > 0) return `${trimmed.slice(0, 1)}***@${trimmed.slice(at + 1)}`
  if (trimmed.length <= 2) return "***"
  return `${trimmed.slice(0, 1)}***${trimmed.slice(-1)}`
}

export function projectProfile(profile: PublicProfile): PhoneProfile {
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    shipping: profile.shipping,
    billing: profile.billing,
    cardName: profile.cardName,
    last4: profile.last4,
    expMonth: profile.expMonth,
    expYear: profile.expYear,
    city: profile.shipping?.city ?? "",
    state: profile.shipping?.state ?? "",
    clientId: profile.clientId
  }
}

export function projectProxyGroup(group: { id: string; name: string; proxies?: unknown[] | null }): PhoneProxyGroup {
  return { id: group.id, name: group.name, count: Array.isArray(group.proxies) ? group.proxies.length : 0 }
}

export function projectAccount(account: PublicAccount): PhoneAccount {
  return {
    id: account.id,
    store: account.store,
    label: account.label,
    usernameMasked: maskUsername(account.username),
    hasPassword: account.hasPassword,
    hasSession: account.hasSession,
    sessionState: account.sessionState,
    lastWarmAt: account.lastWarmAt,
    clientId: account.clientId,
    proxyGroupId: account.proxyGroupId
  }
}

export function projectTask(task: PublicTask, profiles: PublicProfile[], accounts: PublicAccount[], groups: { id: string; name: string }[]): PhoneTask {
  return {
    id: task.id,
    store: task.store,
    storeName: storeName(task.store),
    sku: task.sku,
    quantity: task.quantity,
    profileId: task.profileId,
    profileName: profiles.find((profile) => profile.id === task.profileId)?.name ?? "Missing",
    accountId: task.accountId,
    accountLabel: accounts.find((account) => account.id === task.accountId)?.label ?? "Missing",
    proxyGroupId: task.proxyGroupId,
    proxyGroupName: task.proxyGroupId ? groups.find((group) => group.id === task.proxyGroupId)?.name ?? "Missing" : null,
    confirmPurchase: task.confirmPurchase,
    testMode: task.testMode === true,
    group: task.group ?? "",
    imageUrl: task.imageUrl || undefined,
    monitorOnly: task.monitorOnly === true || task.kind === "monitor",
    kind: task.kind === "monitor" || task.monitorOnly ? "monitor" : "checkout",
    keywords: task.keywords ?? "",
    priceCap: task.priceCap ?? null,
    webhook: task.webhook ?? "",
    activeHours: task.activeHours ?? "",
    linkedCheckoutIds: task.linkedCheckoutIds ?? [],
    checkoutDelayMs: task.checkoutDelayMs ?? null,
    maxPrice: task.maxPrice ?? null,
    startMode: task.startMode ?? (task.kind === "monitor" || task.monitorOnly ? "manual" : "builtin"),
    linkedMonitorId: task.linkedMonitorId ?? null,
    jitterPct: task.jitterPct ?? null,
    monitorProxyGroupId: task.monitorProxyGroupId,
    overrides: task.overrides,
    monitorMs: task.monitorMs,
    detectToCartMs: task.detectToCartMs,
    status: task.status,
    detail: redact(task.detail).slice(0, 240),
    logs: (task.logs ?? []).slice(-LOG_LIMIT).map((line) => ({ ...line, message: redact(line.message).slice(0, 500) })),
    createdAt: task.createdAt
  }
}

export function parseTaskDraft(value: unknown): PhoneTaskDraft {
  if (!value || typeof value !== "object") throw new Error("Task is invalid.")
  const input = value as Record<string, unknown>
  if (typeof input.store !== "string" || !isStoreId(input.store)) throw new Error("Choose a store.")
  const kind: TaskKind = input.kind === "monitor" ? "monitor" : "checkout"
  const keywords = typeof input.keywords === "string" ? input.keywords.trim().slice(0, 200) : ""
  const sku = typeof input.sku === "string" ? input.sku.trim() : ""
  if (!sku && !keywords) throw new Error("Product SKU or URL is required.")
  const quantity = Math.round(Number(input.quantity))
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new Error("Quantity must be from 1 to 12.")
  const profileId = typeof input.profileId === "string" ? input.profileId : ""
  const accountId = typeof input.accountId === "string" ? input.accountId : ""
  if (kind !== "monitor") {
    if (!profileId) throw new Error("Choose a profile.")
    if (!accountId) throw new Error("Choose an account.")
  }
  const proxyGroupId = typeof input.proxyGroupId === "string" && input.proxyGroupId ? input.proxyGroupId : null
  const monitorProxyGroupId = typeof input.monitorProxyGroupId === "string" && input.monitorProxyGroupId ? input.monitorProxyGroupId : null
  const modes: StartMode[] = ["manual", "scheduled", "monitor", "restock", "builtin"]
  const startMode = modes.includes(input.startMode as StartMode) ? input.startMode as StartMode : undefined
  return {
    id: typeof input.id === "string" && input.id ? input.id : undefined,
    store: input.store,
    sku,
    quantity,
    profileId,
    accountId,
    proxyGroupId: kind === "monitor" ? null : proxyGroupId,
    confirmPurchase: kind === "monitor" ? false : input.confirmPurchase === true,
    testMode: input.testMode === true,
    group: typeof input.group === "string" ? input.group.trim().slice(0, 40) : "",
    kind,
    keywords,
    priceCap: optionalMoney(input.priceCap),
    webhook: typeof input.webhook === "string" ? input.webhook.trim().slice(0, 300) : "",
    activeHours: typeof input.activeHours === "string" ? input.activeHours.slice(0, 400) : "",
    linkedCheckoutIds: Array.isArray(input.linkedCheckoutIds) ? input.linkedCheckoutIds.filter((id): id is string => typeof id === "string").slice(0, 20) : [],
    checkoutDelayMs: optionalMoney(input.checkoutDelayMs),
    maxPrice: optionalMoney(input.maxPrice),
    startMode,
    linkedMonitorId: typeof input.linkedMonitorId === "string" && input.linkedMonitorId ? input.linkedMonitorId.slice(0, 80) : null,
    jitterPct: optionalMoney(input.jitterPct),
    monitorProxyGroupId,
    overrides: input.overrides && typeof input.overrides === "object" ? input.overrides as TaskOverrides : undefined
  }
}

function optionalMoney(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === "") return null
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : null
}

export function asClientMessage(value: unknown): ClientMessage {
  if (!value || typeof value !== "object") throw new Error("Invalid message.")
  const message = value as ClientMessage
  if (message.type === "pair" && typeof message.deviceName === "string") return { type: "pair", deviceName: message.deviceName }
  if (message.type === "hello") return { type: "hello" }
  if (!("conn" in message) || typeof message.conn !== "string" || !message.conn) throw new Error("Phone session is not ready.")
  if (!("req" in message) || typeof message.req !== "string" || !message.req) throw new Error("Phone request is missing an id.")
  if (message.type === "sync") return { type: "sync", conn: message.conn, req: message.req }
  if (message.type === "task.start" || message.type === "task.test" || message.type === "task.stop" || message.type === "task.delete") {
    if (typeof message.taskId !== "string" || !message.taskId) throw new Error("Choose a task.")
    return { type: message.type, req: message.req, conn: message.conn, taskId: message.taskId }
  }
  if (message.type === "task.startAll" || message.type === "task.stopAll" || message.type === "task.pauseAll") return { type: message.type, req: message.req, conn: message.conn }
  if (message.type === "autopilot.set") return { type: "autopilot.set", req: message.req, conn: message.conn, enabled: message.enabled === true }
  if (message.type === "language.set") return { type: "language.set", req: message.req, conn: message.conn, language: message.language === "es" ? "es" : "en" }
  if (message.type === "mail.delete") {
    if (typeof message.id !== "string" || !message.id) throw new Error("Choose a mailbox.")
    return { type: "mail.delete", req: message.req, conn: message.conn, id: message.id }
  }
  if (message.type === "mail.oauth") {
    if (message.provider !== "gmail" && message.provider !== "outlook") throw new Error("Choose Google or Microsoft.")
    return { type: "mail.oauth", req: message.req, conn: message.conn, provider: message.provider, user: typeof message.user === "string" ? message.user.slice(0, 180) : "" }
  }
  if (message.type === "mail.save") return { type: "mail.save", req: message.req, conn: message.conn, mailbox: parseMailDraft(message.mailbox) }
  if (message.type === "module.save") {
    if (typeof message.store !== "string" || !isStoreId(message.store)) throw new Error("Choose a store.")
    return { type: "module.save", req: message.req, conn: message.conn, store: message.store, record: message.record && typeof message.record === "object" ? message.record : {} }
  }
  if (message.type === "module.reset") {
    if (typeof message.store !== "string" || !isStoreId(message.store)) throw new Error("Choose a store.")
    return { type: "module.reset", req: message.req, conn: message.conn, store: message.store }
  }
  if (message.type === "module.import") {
    if (typeof message.text !== "string" || !message.text.trim()) throw new Error("Paste a store preset.")
    return { type: "module.import", req: message.req, conn: message.conn, text: message.text.slice(0, 20_000) }
  }
  if (message.type === "health.check") {
    const proxyGroupId = "proxyGroupId" in message && typeof message.proxyGroupId === "string" && message.proxyGroupId ? message.proxyGroupId : null
    return { type: "health.check", req: message.req, conn: message.conn, proxyGroupId }
  }
  if (message.type === "task.save") return { type: "task.save", req: message.req, conn: message.conn, task: parseTaskDraft(message.task) }
  if (message.type === "rule.save") return { type: "rule.save", req: message.req, conn: message.conn, rule: parseRuleInput(message.rule) }
  if (message.type === "watch.save") return { type: "watch.save", req: message.req, conn: message.conn, watch: parseWatchInput(message.watch) }
  if (message.type === "rule.delete" || message.type === "rule.toggle") {
    if (typeof message.ruleId !== "string" || !message.ruleId) throw new Error("Choose a restock rule.")
    if (message.type === "rule.toggle") return { type: "rule.toggle", req: message.req, conn: message.conn, ruleId: message.ruleId, enabled: message.enabled === true }
    return { type: "rule.delete", req: message.req, conn: message.conn, ruleId: message.ruleId }
  }
  if (message.type === "watch.delete" || message.type === "watch.toggle" || message.type === "watch.resume") {
    if (typeof message.watchId !== "string" || !message.watchId) throw new Error("Choose a keyword watch.")
    if (message.type === "watch.toggle") return { type: "watch.toggle", req: message.req, conn: message.conn, watchId: message.watchId, enabled: message.enabled === true }
    if (message.type === "watch.resume") return { type: "watch.resume", req: message.req, conn: message.conn, watchId: message.watchId }
    return { type: "watch.delete", req: message.req, conn: message.conn, watchId: message.watchId }
  }
  if (message.type === "challenge.open" || message.type === "challenge.done" || message.type === "challenge.dismiss") {
    return { type: message.type, req: message.req, conn: message.conn }
  }
  if (message.type === "challenge.submit") {
    if (typeof message.cookie !== "string" || !message.cookie.trim()) throw new Error("Solved cookies are missing.")
    return { type: "challenge.submit", req: message.req, conn: message.conn, cookie: message.cookie.replace(/[\r\n]/g, "").slice(0, 8192) }
  }
  if (message.type === "account.login") {
    if (typeof message.accountId !== "string" || !message.accountId) throw new Error("Choose an account.")
    return { type: "account.login", req: message.req, conn: message.conn, accountId: message.accountId }
  }
  if (message.type === "task.duplicate") {
    if (typeof message.taskId !== "string" || !message.taskId) throw new Error("Choose a task.")
    return { type: "task.duplicate", req: message.req, conn: message.conn, taskId: message.taskId }
  }
  if (message.type === "analytics.csv") return { type: "analytics.csv", req: message.req, conn: message.conn }
  if (message.type === "vault.link" || message.type === "vault.unlink" || message.type === "vault.push" || message.type === "vault.pull") {
    if (typeof message.accountId !== "string" || !message.accountId) throw new Error("Choose an account.")
    if (message.type === "vault.link") return { type: "vault.link", req: message.req, conn: message.conn, accountId: message.accountId, twoWay: message.twoWay === true }
    if (message.type === "vault.unlink") return { type: "vault.unlink", req: message.req, conn: message.conn, accountId: message.accountId }
    if (message.type === "vault.pull") return { type: "vault.pull", req: message.req, conn: message.conn, accountId: message.accountId }
    const cookie = typeof message.cookie === "string" ? message.cookie.replace(/[\r\n]/g, "").trim() : ""
    if (!cookie) throw new Error("The browser session is empty.")
    const expiresAt = typeof message.expiresAt === "number" && Number.isFinite(message.expiresAt) ? message.expiresAt : null
    return { type: "vault.push", req: message.req, conn: message.conn, accountId: message.accountId, cookie: cookie.slice(0, 8192), expiresAt }
  }
  if (message.type === "schedule.delete") {
    if (typeof message.scheduleId !== "string" || !message.scheduleId) throw new Error("Choose a drop.")
    return { type: "schedule.delete", req: message.req, conn: message.conn, scheduleId: message.scheduleId }
  }
  if (message.type === "schedule.save") {
    if (typeof message.name !== "string" || !message.name.trim()) throw new Error("Name the drop.")
    if (typeof message.startAt !== "string" || !message.startAt) throw new Error("Choose a start time.")
    return {
      type: "schedule.save",
      req: message.req,
      conn: message.conn,
      name: message.name,
      startAt: message.startAt,
      stopAt: typeof message.stopAt === "string" ? message.stopAt : "",
      warmupMin: Number(message.warmupMin),
      group: typeof message.group === "string" ? message.group : "",
      taskIds: Array.isArray(message.taskIds) ? message.taskIds.filter((id) => typeof id === "string") : []
    }
  }
  if (message.type === "task.bulk") {
    if (typeof message.text !== "string" || !message.text.trim()) throw new Error("Paste at least one SKU or URL.")
    if (typeof message.store !== "string" || !isStoreId(message.store)) throw new Error("Choose a store.")
    if (typeof message.profileId !== "string" || !message.profileId) throw new Error("Choose a profile.")
    if (typeof message.accountId !== "string" || !message.accountId) throw new Error("Choose an account.")
    return {
      type: "task.bulk",
      req: message.req,
      conn: message.conn,
      text: message.text.slice(0, 20_000),
      store: message.store,
      quantity: Number(message.quantity),
      profileId: message.profileId,
      accountId: message.accountId,
      proxyGroupId: typeof message.proxyGroupId === "string" && message.proxyGroupId ? message.proxyGroupId : null,
      confirmPurchase: message.confirmPurchase === true,
      testMode: message.testMode === true,
      group: typeof message.group === "string" ? message.group.slice(0, 40) : ""
    }
  }
  const desk = parseDeskMessage(message)
  if (desk) return desk
  throw new Error("Unknown phone request.")
}

export function parseMailDraft(value: unknown): PhoneMailDraft {
  if (!value || typeof value !== "object") throw new Error("Mailbox is invalid.")
  const input = value as Record<string, unknown>
  const user = typeof input.user === "string" ? input.user.trim().slice(0, 180) : ""
  if (!user.includes("@")) throw new Error("Enter an email address.")
  const provider = input.provider === "gmail" || input.provider === "outlook" || input.provider === "icloud" || input.provider === "yahoo" || input.provider === "custom" ? input.provider : "custom"
  const port = Math.round(Number(input.port))
  return {
    id: typeof input.id === "string" && input.id ? input.id : undefined,
    user,
    provider,
    host: typeof input.host === "string" ? input.host.trim().slice(0, 253) : "",
    port: Number.isInteger(port) ? port : 993,
    secure: input.secure !== false,
    mailbox: typeof input.mailbox === "string" && input.mailbox.trim() ? input.mailbox.trim().slice(0, 80) : "INBOX",
    password: typeof input.password === "string" ? input.password.slice(0, 200) : "",
    orders: input.orders !== false,
    alerts: input.alerts === true,
    codes: input.codes !== false
  }
}

export function parseRuleInput(value: unknown): RestockRuleInput {
  if (!value || typeof value !== "object") throw new Error("Rule is invalid.")
  const input = value as Record<string, unknown>
  const rawStore = input.store === undefined || input.store === null ? "" : input.store
  if (typeof rawStore !== "string" || (rawStore !== "" && !isStoreId(rawStore))) throw new Error("Choose a store.")
  const store: StoreId | "" = rawStore === "" ? "" : rawStore
  return {
    id: typeof input.id === "string" && input.id ? input.id : undefined,
    name: typeof input.name === "string" ? input.name : "",
    enabled: input.enabled === true,
    store,
    sku: typeof input.sku === "string" ? input.sku : "",
    keywords: typeof input.keywords === "string" ? input.keywords : "",
    taskId: typeof input.taskId === "string" && input.taskId ? input.taskId : null,
    profileId: typeof input.profileId === "string" ? input.profileId : "",
    accountId: typeof input.accountId === "string" ? input.accountId : "",
    proxyGroupId: typeof input.proxyGroupId === "string" && input.proxyGroupId ? input.proxyGroupId : null,
    quantity: Number(input.quantity),
    maxQuantity: Number(input.maxQuantity),
    maxPrice: input.maxPrice === null || input.maxPrice === "" ? null : Number(input.maxPrice),
    cooldownSec: Number(input.cooldownSec),
    testMode: input.testMode === true,
    confirmPurchase: input.confirmPurchase === true
  }
}

export function parseWatchInput(value: unknown): KeywordWatchInput {
  if (!value || typeof value !== "object") throw new Error("Watch is invalid.")
  const input = value as Record<string, unknown>
  if (typeof input.store !== "string" || !isStoreId(input.store)) throw new Error("Choose a store.")
  return {
    id: typeof input.id === "string" && input.id ? input.id : undefined,
    name: typeof input.name === "string" ? input.name : "",
    enabled: input.enabled === true,
    store: input.store,
    keywords: typeof input.keywords === "string" ? input.keywords : "",
    maxPrice: input.maxPrice === null || input.maxPrice === "" ? null : Number(input.maxPrice),
    soldByRetailer: input.soldByRetailer !== false,
    proxyGroupId: typeof input.proxyGroupId === "string" && input.proxyGroupId ? input.proxyGroupId : null,
    profileId: typeof input.profileId === "string" ? input.profileId : "",
    accountId: typeof input.accountId === "string" ? input.accountId : "",
    quantity: Number(input.quantity),
    maxQuantity: Number(input.maxQuantity),
    autoStart: input.autoStart === true,
    testMode: input.testMode === true,
    confirmPurchase: input.confirmPurchase === true,
    resetSeen: input.resetSeen === true
  }
}

function derive(secret: string, info: Uint8Array): Uint8Array {
  return hkdf(sha256, b64ToBytes(secret), new Uint8Array(), info, 32)
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = ""
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

export function b64ToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Phone frame is not valid.")
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4))
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}
