import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { AppError } from "../shared/errors"
import type { HttpClient } from "./http"

export interface LicensePayload {
  v: 1
  id: string
  holder: string
  seats: number
  exp: number | null
}

export interface IssuedLicense {
  id: string
  holder: string
  seats: number
  expiresAt: number | null
  revoked: boolean
  machines: string[]
}

const FORBIDDEN = ["cardnumber", "card", "cvv", "password", "cookie", "cookies", "session", "pan", "proxy", "accesstoken"]

export function createLicenseIdentity(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("ed25519")
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")
  }
}

export function signLicense(privateKey: string, input: { holder: string; seats: number; expiresAt: number | null }): { token: string; payload: LicensePayload } {
  const holder = input.holder.trim().slice(0, 80)
  if (!holder) throw new AppError("Enter a name for this license.")
  const seats = Math.round(Number(input.seats))
  if (!Number.isInteger(seats) || seats < 1 || seats > 50) throw new AppError("Seats must be from 1 to 50.")
  const expiresAt = input.expiresAt
  if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt < Date.now() - 60_000)) {
    throw new AppError("Expiry has to be a future time, or blank.")
  }
  const payload: LicensePayload = { v: 1, id: randomUUID(), holder, seats, exp: expiresAt }
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = sign(null, Buffer.from(body), createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }))
  return { token: `${body}.${signature.toString("base64url")}`, payload }
}

export function readLicense(token: string, publicKey: string): LicensePayload {
  const parts = token.trim().split(".")
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new AppError("That license key is not valid.")
  let ok = false
  try {
    ok = verify(
      null,
      Buffer.from(parts[0]),
      createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }),
      Buffer.from(parts[1], "base64url")
    )
  } catch {
    ok = false
  }
  if (!ok) throw new AppError("That license key is not valid.")
  let payload: LicensePayload
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as LicensePayload
  } catch {
    throw new AppError("That license key is not valid.")
  }
  if (!payload || payload.v !== 1 || typeof payload.id !== "string" || typeof payload.holder !== "string") {
    throw new AppError("That license key is not valid.")
  }
  const seats = Math.round(Number(payload.seats))
  if (!Number.isInteger(seats) || seats < 1 || seats > 50) throw new AppError("That license key is not valid.")
  return { v: 1, id: payload.id, holder: payload.holder.slice(0, 80), seats, exp: payload.exp === null ? null : Number(payload.exp) }
}

export function assertLicenseAllowed(payload: LicensePayload, now = Date.now()): void {
  if (payload.exp !== null && (!Number.isFinite(payload.exp) || payload.exp <= now)) {
    throw new AppError("This license key has expired.")
  }
}

export function bindMachine(record: IssuedLicense, machineId: string, now = Date.now()): IssuedLicense {
  if (record.revoked) throw new AppError("This license key was revoked.")
  if (record.expiresAt !== null && record.expiresAt <= now) throw new AppError("This license key has expired.")
  if (!/^[0-9a-f-]{36}$/i.test(machineId)) throw new AppError("This PC does not have a machine id yet.")
  if (record.machines.includes(machineId)) return record
  if (record.machines.length >= record.seats) throw new AppError("This license key is already active on its allowed PCs.")
  return { ...record, machines: [...record.machines, machineId] }
}

export function activationRequest(key: string, machineId: string, version: string): string {
  return JSON.stringify({ key, machineId, version })
}

export function assertActivationBody(raw: string): { key: string; machineId: string; version: string } {
  const parsed = parseObject(raw)
  rejectSecrets(parsed)
  const keys = Object.keys(parsed)
  if (keys.some((key) => !["key", "machineId", "version"].includes(key))) {
    throw new AppError("The license request can only include the key, this PC, and the app version.")
  }
  const key = typeof parsed.key === "string" ? parsed.key.trim() : ""
  const machineId = typeof parsed.machineId === "string" ? parsed.machineId.trim() : ""
  const version = typeof parsed.version === "string" ? parsed.version.trim().slice(0, 40) : ""
  if (!key || !/^[0-9a-f-]{36}$/i.test(machineId) || !version) throw new AppError("The license request is incomplete.")
  return { key, machineId, version }
}

export function assertLicenseUrl(url: string): string {
  const value = url.trim()
  if (!value) return ""
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AppError("License server must be an https URL, or http on this PC only.")
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new AppError("Do not put a token in the license server URL.")
  if (parsed.protocol === "http:" && loopback) return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "")
  if (parsed.protocol !== "https:") throw new AppError("License server must be an https URL, or http on this PC only.")
  return `${parsed.origin}${parsed.pathname}`.replace(/\/$/, "")
}

export function cleanPublicKey(value: string | undefined): string {
  const key = (value ?? "").trim()
  if (!key) return ""
  if (!/^[A-Za-z0-9+/=]{40,400}$/.test(key)) throw new AppError("License public key should be the key from the seller, or left blank.")
  return key
}

export interface LicenseStatus {
  licenseId: string
  holder: string
  expiresAt: number | null
  seats: number
}

export async function activateRemote(http: HttpClient, url: string, key: string, machineId: string, version: string): Promise<LicenseStatus> {
  const target = assertLicenseUrl(url)
  if (!target) throw new AppError("Enter the license server URL.")
  const response = await http.request({
    method: "POST",
    url: `${target}/v1/activate`,
    headers: { "content-type": "application/json" },
    body: activationRequest(key, machineId, version),
    redirect: "manual",
    timeoutMs: 15000
  })
  if (response.status >= 300 && response.status < 400) throw new AppError("The license server redirected. Zzz AIO did not follow it.")
  if (response.status < 200 || response.status >= 300) throw new AppError(`The license server returned ${response.status}.`)
  const parsed = parseObject(response.body)
  rejectSecrets(parsed)
  if (parsed.ok !== true) throw new AppError(typeof parsed.error === "string" ? parsed.error : "This PC was not activated.")
  const holder = typeof parsed.holder === "string" ? parsed.holder.slice(0, 80) : ""
  const licenseId = typeof parsed.licenseId === "string" ? parsed.licenseId : ""
  const seats = Math.round(Number(parsed.seats))
  const expiresAt = parsed.expiresAt === null || parsed.expiresAt === undefined ? null : Number(parsed.expiresAt)
  if (!holder || !licenseId || !Number.isInteger(seats)) throw new AppError("The license server response was incomplete.")
  return { licenseId, holder, seats, expiresAt }
}

export interface LicenseStore {
  publicKey(): string
  adminOk(token: string): boolean
  findToken(key: string): IssuedLicense | null
  remember(record: IssuedLicense, key: string): void
  list(): IssuedLicense[]
  mint(input: { holder: string; seats: number; expiresAt: number | null }): { token: string; record: IssuedLicense }
  revoke(id: string): void
}

export function handleLicenseHttp(store: LicenseStore, method: string, path: string, headers: Record<string, string | undefined>, raw: string): { status: number; body: string } {
  try {
    if (method === "POST" && path === "/v1/activate") {
      const request = assertActivationBody(raw)
      const payload = readLicense(request.key, store.publicKey())
      assertLicenseAllowed(payload)
      const existing = store.findToken(request.key)
      const record = bindMachine(existing ?? {
        id: payload.id,
        holder: payload.holder,
        seats: payload.seats,
        expiresAt: payload.exp,
        revoked: false,
        machines: []
      }, request.machineId)
      store.remember(record, request.key)
      return json(200, { ok: true, licenseId: record.id, holder: record.holder, seats: record.seats, expiresAt: record.expiresAt })
    }
    if (!store.adminOk(bearer(headers))) return json(401, { ok: false, error: "Admin token was rejected." })
    if (method === "GET" && path === "/v1/admin/licenses") return json(200, { ok: true, licenses: store.list() })
    if (method === "POST" && path === "/v1/admin/licenses") {
      const body = parseObject(raw)
      rejectSecrets(body)
      const minted = store.mint({
        holder: typeof body.holder === "string" ? body.holder : "",
        seats: Number(body.seats),
        expiresAt: body.expiresAt === null || body.expiresAt === undefined || body.expiresAt === "" ? null : Number(body.expiresAt)
      })
      return json(200, { ok: true, id: minted.record.id, key: minted.token, holder: minted.record.holder, seats: minted.record.seats, expiresAt: minted.record.expiresAt })
    }
    if (method === "POST" && path === "/v1/admin/revoke") {
      const body = parseObject(raw)
      rejectSecrets(body)
      if (typeof body.id !== "string") throw new AppError("Choose a license.")
      store.revoke(body.id)
      return json(200, { ok: true })
    }
    return json(404, { ok: false, error: "Not found." })
  } catch (err) {
    const message = err instanceof Error ? err.message : "License request failed."
    return json(400, { ok: false, error: message })
  }
}

export function listenLicense(port: number, store: LicenseStore): Promise<{ url: string; close(): Promise<void> }> {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AppError("License server port must be from 0 to 65535.")
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      if (chunks.reduce((sum, item) => sum + item.length, 0) > 20_000) req.destroy()
    })
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const result = handleLicenseHttp(store, req.method ?? "GET", url.pathname, headersOf(req), Buffer.concat(chunks).toString("utf8"))
      writeJson(res, result.status, result.body)
    })
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      const address = server.address()
      const bound = typeof address === "object" && address ? address.port : port
      resolve({
        url: `http://127.0.0.1:${bound}`,
        close: () => new Promise((done, fail) => server.close((err) => err ? fail(err) : done()))
      })
    })
  })
}

function bearer(headers: Record<string, string | undefined>): string {
  const value = headers.authorization ?? headers.Authorization ?? ""
  const match = /^Bearer\s+(\S+)$/.exec(value)
  return match?.[1] ?? ""
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value[0] : value
  return headers
}

function writeJson(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(body)
}

function json(status: number, body: unknown): { status: number; body: string } {
  return { status, body: JSON.stringify(body) }
}

function parseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape")
    return parsed as Record<string, unknown>
  } catch {
    throw new AppError("License JSON could not be parsed.")
  }
}

function rejectSecrets(body: Record<string, unknown>): void {
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN.includes(key.toLowerCase())) throw new AppError("License data cannot include card, password, cookie, or session fields.")
      walk(child)
    }
  }
  walk(body)
}
