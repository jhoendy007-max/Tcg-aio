import { pbkdf2Sync, createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { AppError } from "../shared/errors"
import type { HttpClient } from "./http"
import type { Client, LedgerEntry } from "../shared/clients"
import type {
  Address,
  DropSchedule,
  ProxyGroup,
  PublicTask,
  SessionCookies,
  Settings,
  StoreId,
  TaskTemplate
} from "../shared/types"

export const BACKUP_ITER = 210_000

export interface BackupCard {
  number: string
  cvv: string
  expMonth: string
  expYear: string
  name: string
}

export interface BackupProfile {
  id: string
  name: string
  email: string
  phone: string
  shipping: Address
  billing: Address
  cardName: string
  last4: string
  expMonth: string
  expYear: string
  card: BackupCard
  clientId?: string
}

export interface BackupAccount {
  id: string
  store: StoreId
  label: string
  username: string
  password?: string
  session?: SessionCookies
  proxyGroupId: string | null
  sessionState: "missing" | "saved" | "expired"
  lastWarmAt: number | null
  clientId?: string
}

/** Plaintext that only exists inside the user-held ciphertext. */
export interface BackupDocument {
  v: 1
  settings: Settings
  tasks: PublicTask[]
  profiles: BackupProfile[]
  accounts: BackupAccount[]
  proxyGroups: ProxyGroup[]
  schedules: DropSchedule[]
  templates: TaskTemplate[]
  clients?: Client[]
  ledger?: LedgerEntry[]
}

interface Envelope {
  v: 1
  kdf: "pbkdf2-sha256"
  iter: number
  salt: string
  iv: string
  tag: string
  ct: string
}

export function sealBackup(doc: BackupDocument, passphrase: string): string {
  const secret = requirePassphrase(passphrase)
  const plain = JSON.stringify(doc)
  if (/"tokenSecret"|"passwordSecret"|"cardSecret"|"sessionSecret"/.test(plain)) {
    throw new AppError("The backup still had a local encryption field. It was not written.")
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = pbkdf2Sync(secret, salt, BACKUP_ITER, 32, "sha256")
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const envelope: Envelope = {
    v: 1,
    kdf: "pbkdf2-sha256",
    iter: BACKUP_ITER,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64")
  }
  return JSON.stringify(envelope)
}

export function openBackup(file: string, passphrase: string): BackupDocument {
  const secret = requirePassphrase(passphrase)
  let envelope: Envelope
  try {
    envelope = JSON.parse(file) as Envelope
  } catch {
    throw new AppError("That file is not a TCGAIO backup.")
  }
  if (!envelope || envelope.v !== 1 || envelope.kdf !== "pbkdf2-sha256") {
    throw new AppError("This backup was written by a newer TCGAIO version.")
  }
  const iter = Math.round(Number(envelope.iter))
  if (!Number.isInteger(iter) || iter < 100_000 || iter > 1_000_000) {
    throw new AppError("This backup was written by a newer TCGAIO version.")
  }
  try {
    const salt = Buffer.from(envelope.salt, "base64")
    const iv = Buffer.from(envelope.iv, "base64")
    const tag = Buffer.from(envelope.tag, "base64")
    const ct = Buffer.from(envelope.ct, "base64")
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || !ct.length) throw new Error("shape")
    const key = pbkdf2Sync(secret, salt, iter, 32, "sha256")
    const decipher = createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
    const doc = JSON.parse(plain) as BackupDocument
    if (!doc || doc.v !== 1) throw new Error("version")
    return doc
  } catch (err) {
    if (err instanceof AppError) throw err
    throw new AppError("That backup passphrase did not open this file.")
  }
}

export function assertBackupUrl(url: string): string {
  const value = url.trim()
  if (!value) return ""
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AppError("Backup URL must be an https link you control.")
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AppError("Backup URL must be https, with no token in the link. The upload token stays on this PC.")
  }
  if (value.length > 300) throw new AppError("Backup URL is too long.")
  return parsed.origin + parsed.pathname
}

export async function putBackup(http: HttpClient, url: string, token: string, body: string): Promise<void> {
  const target = assertBackupUrl(url)
  if (!target) throw new AppError("Enter the https URL that stores the encrypted backup.")
  const response = await http.request({
    method: "PUT",
    url: target,
    headers: cloudHeaders(token),
    body,
    redirect: "manual",
    timeoutMs: 20000
  })
  if (response.status >= 300 && response.status < 400) throw new AppError("The backup URL redirected. TCGAIO did not follow it.")
  if (response.status < 200 || response.status >= 300) throw new AppError(`The backup host returned ${response.status}.`)
}

export async function getBackup(http: HttpClient, url: string, token: string): Promise<string> {
  const target = assertBackupUrl(url)
  if (!target) throw new AppError("Enter the https URL that stores the encrypted backup.")
  const response = await http.request({
    method: "GET",
    url: target,
    headers: cloudHeaders(token),
    redirect: "manual",
    timeoutMs: 20000
  })
  if (response.status >= 300 && response.status < 400) throw new AppError("The backup URL redirected. TCGAIO did not follow it.")
  if (response.status < 200 || response.status >= 300) throw new AppError(`The backup host returned ${response.status}.`)
  if (!response.body.includes("\"ct\"")) throw new AppError("That host did not return an encrypted backup.")
  return response.body
}

function cloudHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" }
  const trimmed = token.trim()
  if (!trimmed) return headers
  if (trimmed.length < 8 || /[\r\n\s]/.test(trimmed)) throw new AppError("Backup token is invalid.")
  headers.authorization = `Bearer ${trimmed}`
  return headers
}

function requirePassphrase(passphrase: string): string {
  const value = passphrase ?? ""
  if (value.length < 8 || value.length > 200) throw new AppError("Backup passphrase must be 8 to 200 characters. It is not saved.")
  return value
}
