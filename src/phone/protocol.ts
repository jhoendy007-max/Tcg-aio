import { gcm } from "@noble/ciphers/aes"
import { hkdf } from "@noble/hashes/hkdf"
import { sha256 } from "@noble/hashes/sha2"
import { bytesToUtf8, randomBytes, utf8ToBytes } from "@noble/hashes/utils"
import { redact } from "../shared/redact"
import { isStoreId, storeName } from "../shared/stores"
import type { LogLine, PublicAccount, PublicProfile, PublicTask, StoreId, StoreInfo, TaskStatus } from "../shared/types"

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
}

export interface PhoneProfile {
  id: string
  name: string
  last4: string
  city: string
  state: string
}

export interface PhoneAccount {
  id: string
  store: StoreId
  label: string
  usernameMasked: string
  hasPassword: boolean
  hasSession: boolean
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
  status: TaskStatus
  detail: string
  logs: LogLine[]
  createdAt: number
}

export interface PhoneSnapshot {
  pcName: string
  tasks: PhoneTask[]
  profiles: PhoneProfile[]
  accounts: PhoneAccount[]
  proxyGroups: PhoneProxyGroup[]
  stores: StoreInfo[]
}

export interface PhoneNotice {
  kind: "success" | "failure" | "paused"
  storeName: string
  sku: string
  profileName: string
  detail: string
  orderId?: string
  ts: number
}

export interface PhoneTaskDraft {
  id?: string
  store: StoreId
  sku: string
  quantity: number
  profileId: string
  accountId: string
  proxyGroupId: string | null
  confirmPurchase: boolean
}

export type ClientMessage =
  | { type: "pair"; deviceName: string }
  | { type: "hello" }
  | { type: "sync"; req: string; conn: string }
  | { type: "task.start"; req: string; conn: string; taskId: string }
  | { type: "task.stop"; req: string; conn: string; taskId: string }
  | { type: "task.startAll"; req: string; conn: string }
  | { type: "task.stopAll"; req: string; conn: string }
  | { type: "task.save"; req: string; conn: string; task: PhoneTaskDraft }
  | { type: "task.delete"; req: string; conn: string; taskId: string }

export type ServerMessage =
  | { type: "paired"; token: string; deviceId: string; pcName: string }
  | { type: "presence"; online: true; pcName: string }
  | { type: "snapshot"; conn: string; snapshot: PhoneSnapshot }
  | { type: "task"; task: PhoneTask }
  | { type: "task.deleted"; id: string }
  | { type: "notice"; notice: PhoneNotice }
  | { type: "result"; req: string; ok: true; started?: string[]; errors?: { id: string; error: string }[]; task?: PhoneTask }
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
    last4: profile.last4,
    city: profile.shipping.city,
    state: profile.shipping.state
  }
}

export function projectProxyGroup(group: { id: string; name: string; proxies: unknown[] }): PhoneProxyGroup {
  return { id: group.id, name: group.name, count: group.proxies.length }
}

export function projectAccount(account: PublicAccount): PhoneAccount {
  return {
    id: account.id,
    store: account.store,
    label: account.label,
    usernameMasked: maskUsername(account.username),
    hasPassword: account.hasPassword,
    hasSession: account.hasSession
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
    status: task.status,
    detail: redact(task.detail).slice(0, 240),
    logs: task.logs.slice(-LOG_LIMIT).map((line) => ({ ...line, message: redact(line.message).slice(0, 500) })),
    createdAt: task.createdAt
  }
}

export function parseTaskDraft(value: unknown): PhoneTaskDraft {
  if (!value || typeof value !== "object") throw new Error("Task is invalid.")
  const input = value as Record<string, unknown>
  if (typeof input.store !== "string" || !isStoreId(input.store)) throw new Error("Choose a store.")
  if (typeof input.sku !== "string" || !input.sku.trim()) throw new Error("Product SKU or URL is required.")
  const quantity = Math.round(Number(input.quantity))
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 12) throw new Error("Quantity must be from 1 to 12.")
  if (typeof input.profileId !== "string" || !input.profileId) throw new Error("Choose a profile.")
  if (typeof input.accountId !== "string" || !input.accountId) throw new Error("Choose an account.")
  const proxyGroupId = typeof input.proxyGroupId === "string" && input.proxyGroupId ? input.proxyGroupId : null
  return {
    id: typeof input.id === "string" && input.id ? input.id : undefined,
    store: input.store,
    sku: input.sku.trim(),
    quantity,
    profileId: input.profileId,
    accountId: input.accountId,
    proxyGroupId,
    confirmPurchase: input.confirmPurchase === true
  }
}

export function asClientMessage(value: unknown): ClientMessage {
  if (!value || typeof value !== "object") throw new Error("Invalid message.")
  const message = value as ClientMessage
  if (message.type === "pair" && typeof message.deviceName === "string") return { type: "pair", deviceName: message.deviceName }
  if (message.type === "hello") return { type: "hello" }
  if (!("conn" in message) || typeof message.conn !== "string" || !message.conn) throw new Error("Phone session is not ready.")
  if (!("req" in message) || typeof message.req !== "string" || !message.req) throw new Error("Phone request is missing an id.")
  if (message.type === "sync") return { type: "sync", conn: message.conn, req: message.req }
  if (message.type === "task.start" || message.type === "task.stop" || message.type === "task.delete") {
    if (typeof message.taskId !== "string" || !message.taskId) throw new Error("Choose a task.")
    return { type: message.type, req: message.req, conn: message.conn, taskId: message.taskId }
  }
  if (message.type === "task.startAll" || message.type === "task.stopAll") return { type: message.type, req: message.req, conn: message.conn }
  if (message.type === "task.save") return { type: "task.save", req: message.req, conn: message.conn, task: parseTaskDraft(message.task) }
  throw new Error("Unknown phone request.")
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
