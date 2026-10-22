import { createHash, createPrivateKey, createPublicKey, randomBytes, timingSafeEqual } from "node:crypto"
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage } from "node:http"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { argon2id } from "@noble/hashes/argon2"
import {
  PhoneRelayHub,
  authorizeRelayJoin,
  migratePhoneRelay,
  mintPhoneDevice,
  mintPhoneInvite,
  provisionPhoneChannel,
  revokePhoneDevice
} from "./phone-relay"
import {
  GRANT_GRACE_MS,
  OWNER_DEVICE_LIMIT,
  USER_DEVICE_LIMIT,
  createLicenseIdentity,
  signEnvelope,
  type AccessGrant
} from "./proof"
import { featuresForPlan, isPlanId, PLAN_IDS } from "./plans"

export const OWNER_EMAIL = "jhoendy007@gmail.com"
export const ALERT_TYPES = ["signup", "claimed", "foreign_pc", "failed_logins", "expiring", "revoked", "suspended", "server_error", "checkout"] as const
export type AlertType = (typeof ALERT_TYPES)[number]

const ARGON = { t: 2, m: 8192, p: 1, dkLen: 32 }
const YEAR_MS = 365 * 24 * 60 * 60 * 1000
const TRANSFER_MS = 30 * 24 * 60 * 60 * 1000
const ADMIN_MS = 12 * 60 * 60 * 1000
const SESSION_MS = 30 * 24 * 60 * 60 * 1000
const RATE_WINDOW_MS = 10 * 60 * 1000
const RATE_LIMIT = 8
const FAIL_ALERT = 5

export interface LicenseApiOptions {
  dbPath: string
  privateKey?: string
  now?: () => number
  push?: (message: { title: string; body: string; type: AlertType }) => void
  ownerSetupToken?: string
  ownerPassword?: string
  adminUploadToken?: string
  adminApkDir?: string
}

export interface LicenseApi {
  publicKey: string
  handle(method: string, path: string, headers: Record<string, string | undefined>, raw: string, ip?: string): { status: number; body: string }
  storeAdminApk(input: { version: string; versionCode: number; bytes: Buffer; authorization: string; notes?: string }): { status: number; body: string }
  adminDownload(headers: Record<string, string | undefined>, ticket?: string): { status: number; body: string; file?: string; size?: number }
  attachRelay(server: { on(event: "upgrade", listener: (req: IncomingMessage, socket: unknown, head: Buffer) => void): void }): void
  close(): void
}

export function openLicenseApi(options: LicenseApiOptions): LicenseApi {
  const now = options.now ?? (() => Date.now())
  const db = new DatabaseSync(options.dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL,
      verified INTEGER NOT NULL,
      license_id TEXT,
      setup_hash TEXT,
      created_at INTEGER NOT NULL DEFAULT 0,
      account_status TEXT NOT NULL DEFAULT 'active',
      payment_method TEXT NOT NULL DEFAULT 'Not configured',
      paid INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS licenses (
      id TEXT PRIMARY KEY,
      key_hash TEXT,
      note TEXT NOT NULL,
      plan TEXT NOT NULL,
      expires_at INTEGER,
      status TEXT NOT NULL,
      fingerprint TEXT,
      devices TEXT NOT NULL,
      last_seen INTEGER,
      user_id TEXT,
      last_transfer_at INTEGER,
      device_limit INTEGER NOT NULL,
      last_expiry_alert INTEGER,
      fingerprint_confirmed INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      kind TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS push_tokens (token TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS notifications (type TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_failures (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, ip TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_download_tickets (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `)
  migrateUsers(db)
  for (const type of ALERT_TYPES) {
    db.prepare("INSERT OR IGNORE INTO notifications (type, enabled) VALUES (?, ?)").run(type, type === "checkout" ? 0 : 1)
  }
  const identity = loadIdentity(db, options.privateKey)
  ensureOwner(db, options)
  migratePhoneRelay(db)
  const relay = new PhoneRelayHub((input) => authorizeRelayJoin(db, input, now()))
  const apkDir = options.adminApkDir?.trim() || dirname(options.dbPath)
  const rates = new Map<string, { count: number; resetAt: number }>()

  function handle(method: string, path: string, headers: Record<string, string | undefined>, raw: string, ip = "local"): { status: number; body: string } {
    try {
      const url = new URL(path, "http://127.0.0.1")
      const route = url.pathname.replace(/\/$/, "") || "/"
      if (method === "GET" && route === "/admin") return { status: 200, body: "" }
      if (method === "GET" && route === "/health") return json(200, { ok: true })
      if (method === "GET" && route === "/v1/public-key") return json(200, { ok: true, publicKey: identity.publicKey })
      const body = raw ? parseObject(raw) : {}
      if (requestHasSecret(body)) return json(400, { ok: false, error: "License data cannot include card, cookie, or session fields." })
      if (method === "POST" && route === "/v1/owner/setup") return setupOwner(db, body, now)
      if ((method === "POST" && (route === "/v1/account/login" || route === "/v1/account/claim" || route === "/v1/account/signup" || route === "/v1/admin/login" || route === "/v1/admin/password")) && !takeRate(rates, `${route}:${ip}`, now())) {
        return json(429, { ok: false, error: "Too many attempts. Wait a few minutes and try again." })
      }
      if (method === "POST" && route === "/v1/admin/login") return adminLogin(db, body, now)
      if (method === "POST" && route === "/v1/account/signup") return signup(db, body, now, () => notify(db, options.push, "signup", "New signup", `${normalizeEmail(text(body.email))} created an account and is waiting for a license.`))
      if (method === "POST" && route === "/v1/account/claim") return claim(db, identity.privateKey, body, now, () => notify(db, options.push, "claimed", "License claimed", `${text(body.email)} claimed a license.`))
      if (method === "POST" && route === "/v1/account/redeem") return redeem(db, identity.privateKey, body, now, options.push)
      if (method === "POST" && route === "/v1/account/login") return login(db, identity.privateKey, body, ip, now, options.push)
      if (method === "POST" && route === "/v1/session/heartbeat") return heartbeat(db, identity.privateKey, body, now, options.push)
      if (method === "POST" && route === "/v1/session/confirm") return confirmSession(db, body, now, options.push)
      if (method === "POST" && route === "/v1/session/transfer") return transfer(db, identity.privateKey, body, now)
      if (method === "POST" && route === "/v1/session/checkout") return checkout(db, body, now, options.push)
      if (method === "POST" && (route === "/v1/phone/relay" || route === "/v1/phone/relay/invite" || route === "/v1/phone/relay/device" || route === "/v1/phone/relay/revoke")) {
        const userId = relayUser(db, headers, body, now())
        if (!userId) return json(401, { ok: false, error: "Sign in to this PC again." })
        if (route === "/v1/phone/relay") {
          const next = provisionPhoneChannel(db, userId, body.rotate === true, now())
          return json(200, { ok: true, channel: next.channel, ...(next.pcToken ? { pcToken: next.pcToken } : {}) })
        }
        if (route === "/v1/phone/relay/invite") {
          const invite = mintPhoneInvite(db, userId, now())
          if (!invite) return json(400, { ok: false, error: "Open the phone relay before pairing." })
          return json(200, { ok: true, channel: invite.channel, token: invite.token, expiresAt: invite.expiresAt })
        }
        if (route === "/v1/phone/relay/device") {
          const minted = mintPhoneDevice(db, userId, text(body.deviceId), now())
          if (!minted) return json(400, { ok: false, error: "This phone could not be added to the relay." })
          return json(200, { ok: true, channel: minted.channel, token: minted.token })
        }
        const revoked = revokePhoneDevice(db, userId, text(body.deviceId))
        if (revoked) relay.dropDevice(revoked.channel, text(body.deviceId))
        return json(200, { ok: true })
      }
      const admin = adminUser(db, headers, now())
      if (!admin) return json(401, { ok: false, error: "Sign in to the admin desk again." })
      if (method === "POST" && route === "/v1/admin/password") return changeAdminPassword(db, admin, body)
      if (method === "GET" && route === "/v1/admin/overview") return json(200, { ok: true, ...overview(db, url.searchParams.get("q") ?? "", now) })
      if (method === "GET" && route === "/v1/admin/users") return json(200, { ok: true, ...listUsers(db, url.searchParams.get("q") ?? "", url.searchParams.get("status") ?? "") })
      if (method === "GET" && route === "/v1/admin/app") {
        const release = adminRelease(db)
        return json(200, { ok: true, version: release.version, versionCode: release.versionCode, size: release.size, available: release.available, notes: release.notes })
      }
      if (method === "POST" && route === "/v1/admin/app/ticket") {
        const ticket = mintAdminDownloadTicket(db, now())
        return json(200, { ok: true, ticket: ticket.token, expiresAt: ticket.expiresAt })
      }
      if (method === "POST" && route === "/v1/admin/licenses") return createLicense(db, body, now)
      const userMatch = /^\/v1\/admin\/users\/([^/]+)\/(license|paid|payment|suspend|unsuspend|reset)$/.exec(route)
      if (method === "POST" && userMatch) return userAction(db, userMatch[1], userMatch[2], body, now, options.push)
      const planMatch = /^\/v1\/admin\/licenses\/([^/]+)\/plan$/.exec(route)
      if (method === "POST" && planMatch) return changePlan(db, planMatch[1], body)
      const deleteMatch = /^\/v1\/admin\/licenses\/([^/]+)$/.exec(route)
      if (method === "DELETE" && deleteMatch) return deleteLicense(db, deleteMatch[1], admin.email ?? "admin", now)
      if (method === "GET" && route === "/v1/admin/plans") return json(200, { ok: true, plans: PLAN_IDS })
      const licenseMatch = /^\/v1\/admin\/licenses\/([^/]+)\/(access|reset|suspend|revoke)$/.exec(route)
      if (method === "POST" && licenseMatch) return licenseAction(db, licenseMatch[1], licenseMatch[2], options.push)
      if (method === "GET" && route === "/v1/admin/notifications") return json(200, { ok: true, notifications: notificationMap(db) })
      if (method === "PUT" && route === "/v1/admin/notifications") return saveNotifications(db, body)
      if (method === "POST" && route === "/v1/admin/push") return savePush(db, admin.id, body)
      return json(404, { ok: false, error: "Not found." })
    } catch (err) {
      const message = err instanceof Error ? err.message : "License request failed."
      if (message === "License request failed.") notify(db, options.push, "server_error", "License server error", "The license server hit an unexpected error.")
      return json(400, { ok: false, error: message })
    }
  }

  function storeAdminApk(input: { version: string; versionCode: number; bytes: Buffer; authorization: string; notes?: string }): { status: number; body: string } {
    const configured = normalizeUploadToken(options.adminUploadToken ?? process.env.TCGAIO_ADMIN_UPLOAD_TOKEN ?? "")
    if (!configured) return json(404, { ok: false, error: "Admin APK upload is not configured." })
    const presented = normalizeUploadToken(input.authorization)
    if (!presented || !safeEqual(sha(presented), sha(configured))) {
      return json(401, { ok: false, error: `The upload token was not accepted. Sent length ${presented.length}, server length ${configured.length}.` })
    }
    const version = input.version.trim()
    if (!/^\d+\.\d+\.\d+/.test(version)) return json(400, { ok: false, error: "The admin app version is missing." })
    if (!Number.isInteger(input.versionCode) || input.versionCode < 1) return json(400, { ok: false, error: "The admin app version code is missing." })
    if (input.bytes.length < 64 || input.bytes.length > 80_000_000 || input.bytes[0] !== 0x50 || input.bytes[1] !== 0x4b) {
      return json(400, { ok: false, error: "Upload the admin APK file." })
    }
    mkdirSync(apkDir, { recursive: true })
    const file = join(apkDir, "tcgaio-admin.apk")
    writeFileSync(file, input.bytes)
    setMeta(db, "adminApkVersion", version)
    setMeta(db, "adminApkVersionCode", String(input.versionCode))
    setMeta(db, "adminApkFile", file)
    setMeta(db, "adminApkSize", String(input.bytes.length))
    const notes = (input.notes ?? "").replace(/\s+/g, " ").trim().slice(0, 500) || `Admin ${version}`
    setMeta(db, "adminApkNotes", notes)
    return json(200, { ok: true, version, versionCode: input.versionCode, size: input.bytes.length })
  }

  function adminDownload(headers: Record<string, string | undefined>, ticket = ""): { status: number; body: string; file?: string; size?: number } {
    const allowed = ticket ? takeAdminDownloadTicket(db, ticket, now()) : Boolean(adminUser(db, headers, now()))
    if (!allowed) return { status: 401, body: JSON.stringify({ ok: false, error: "Sign in to the admin desk again." }) }
    const release = adminRelease(db)
    if (!release.available || !release.file) return { status: 404, body: JSON.stringify({ ok: false, error: "No admin update has been uploaded." }) }
    return { status: 200, body: "", file: release.file, size: release.size }
  }

  return {
    publicKey: identity.publicKey,
    handle,
    storeAdminApk,
    adminDownload,
    attachRelay: (server) => relay.attach(server),
    close: () => {
      relay.close()
      db.close()
    }
  }
}

export function listenLicenseApi(options: LicenseApiOptions & { port?: number; host?: string; trustProxy?: boolean; adminHtml: string }): Promise<{ url: string; host: string; publicKey: string; close(): Promise<void> }> {
  const api = openLicenseApi(options)
  const bindHost = options.host?.trim() || "127.0.0.1"
  const server = createServer((req, res) => {
    const path = req.url ?? "/"
    const route = path.split("?")[0].replace(/\/$/, "") || "/"
    const upload = (req.method ?? "GET") === "POST" && route === "/v1/admin/app"
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      if (chunks.reduce((sum, item) => sum + item.length, 0) > (upload ? 80_000_000 : 20_000)) req.destroy()
    })
    req.on("end", () => {
      if ((req.method ?? "GET") === "GET" && (path === "/admin" || path.startsWith("/admin?"))) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(options.adminHtml)
        return
      }
      const headers = headersOf(req)
      if ((req.method ?? "GET") === "GET" && route === "/v1/admin/app/download") {
        const ticket = new URL(path, "http://127.0.0.1").searchParams.get("ticket") ?? ""
        const download = api.adminDownload(headers, ticket)
        if (download.file) {
          res.writeHead(200, {
            "content-type": "application/vnd.android.package-archive",
            "content-disposition": "attachment; filename=\"TCGAIO-Admin.apk\"",
            "content-length": download.size ?? 0
          })
          createReadStream(download.file).pipe(res)
          return
        }
        res.writeHead(download.status, { "content-type": "application/json" })
        res.end(download.body)
        return
      }
      if (upload) {
        const version = text(headers["x-tcgaio-version"])
        const versionCode = Number(headers["x-tcgaio-version-code"])
        const result = api.storeAdminApk({ version, versionCode, bytes: Buffer.concat(chunks), authorization: headers["x-tcgaio-upload-token"] || headers.authorization || "", notes: text(headers["x-tcgaio-notes"]) })
        res.writeHead(result.status, { "content-type": "application/json" })
        res.end(result.body)
        return
      }
      const forwarded = req.headers["x-forwarded-for"]
      const ip = clientAddress(req.socket.remoteAddress, Array.isArray(forwarded) ? forwarded[0] : forwarded, options.trustProxy === true)
      const result = api.handle(req.method ?? "GET", path, headers, Buffer.concat(chunks).toString("utf8"), ip)
      const contentType = result.body.startsWith("<") ? "text/html; charset=utf-8" : "application/json"
      res.writeHead(result.status, { "content-type": contentType })
      res.end(result.body)
    })
  })
  api.attachRelay(server)
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port ?? 0, bindHost, () => {
      const address = server.address()
      const boundPort = typeof address === "object" && address ? address.port : options.port ?? 0
      const boundHost = typeof address === "object" && address ? address.address : bindHost
      const shown = boundHost === "0.0.0.0" || boundHost === "::" ? "127.0.0.1" : boundHost
      resolve({
        url: `http://${shown}:${boundPort}`,
        host: boundHost,
        publicKey: api.publicKey,
        close: () => new Promise((done, fail) => {
          api.close()
          server.close((err) => err ? fail(err) : done())
        })
      })
    })
  })
}

/** Client IP for rate limits and failure logs. A loopback proxy, or TRUST_PROXY, supplies X-Forwarded-For. */
export function clientAddress(remoteAddress: string | undefined, forwardedFor: string | undefined, trustProxy = false): string {
  const remote = normalizeIp(remoteAddress) || "local"
  const forwarded = lastForwarded(forwardedFor)
  if (forwarded && (trustProxy || isLoopback(remote))) return forwarded
  return remote
}

function normalizeIp(value: string | undefined): string {
  const raw = (value ?? "").trim()
  if (!raw) return ""
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw)
  return mapped ? mapped[1] : raw
}

function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1"
}

function lastForwarded(header: string | undefined): string {
  if (!header) return ""
  const parts = header.split(",").map((part) => normalizeIp(part)).filter(Boolean)
  return parts.at(-1) ?? ""
}

function loadIdentity(db: DatabaseSync, fromEnv?: string): { publicKey: string; privateKey: string } {
  if (fromEnv?.trim()) {
    const privateKey = fromEnv.trim()
    const publicKey = publicFromPrivate(privateKey)
    db.prepare("INSERT INTO meta (key, value) VALUES ('publicKey', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(publicKey)
    return { publicKey, privateKey }
  }
  const saved = db.prepare("SELECT value FROM meta WHERE key = 'privateKey'").get() as { value: string } | undefined
  if (saved?.value) return { publicKey: publicFromPrivate(saved.value), privateKey: saved.value }
  const created = createLicenseIdentity()
  db.prepare("INSERT INTO meta (key, value) VALUES ('privateKey', ?)").run(created.privateKey)
  db.prepare("INSERT INTO meta (key, value) VALUES ('publicKey', ?)").run(created.publicKey)
  if (process.env.VITEST !== "true") console.log(`License public key (put this in TCGAIO_LICENSE_PUBLIC_KEY): ${created.publicKey}`)
  return created
}

function publicFromPrivate(privateKey: string): string {
  return createPublicKey(createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" })).export({ type: "spki", format: "der" }).toString("base64")
}

function migrateUsers(db: DatabaseSync): void {
  ensureColumn(db, "users", "created_at", "created_at INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "users", "account_status", "account_status TEXT NOT NULL DEFAULT 'active'")
  ensureColumn(db, "users", "payment_method", "payment_method TEXT NOT NULL DEFAULT 'Not configured'")
  ensureColumn(db, "users", "paid", "paid INTEGER NOT NULL DEFAULT 0")
  ensureColumn(db, "licenses", "fingerprint_confirmed", "fingerprint_confirmed INTEGER NOT NULL DEFAULT 1")
  db.prepare("UPDATE users SET account_status = 'pending' WHERE license_id IS NULL AND role != 'owner' AND account_status = 'active'").run()
  migratePlans(db)
}

/** One time: every license from before plans existed had full access, so it becomes ACO. */
function migratePlans(db: DatabaseSync): void {
  const done = db.prepare("SELECT value FROM meta WHERE key = 'plans_v1'").get() as { value: string } | undefined
  if (done) return
  db.prepare("UPDATE licenses SET plan = 'aco' WHERE plan != 'owner'").run()
  db.prepare("INSERT INTO meta (key, value) VALUES ('plans_v1', ?)").run(String(Date.now()))
}

function ensureColumn(db: DatabaseSync, table: string, name: string, definition: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!cols.some((col) => col.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

function ensureOwner(db: DatabaseSync, options: LicenseApiOptions): void {
  let owner = db.prepare("SELECT id, password_hash, setup_hash FROM users WHERE email = ?").get(OWNER_EMAIL) as { id: string; password_hash: string | null; setup_hash: string | null } | undefined
  if (!owner) {
    const id = randomId()
    const licenseId = randomId()
    db.prepare("INSERT INTO licenses (id, key_hash, note, plan, expires_at, status, fingerprint, devices, last_seen, user_id, last_transfer_at, device_limit, last_expiry_alert) VALUES (?, NULL, 'Owner', 'owner', NULL, 'active', NULL, '[]', NULL, ?, NULL, ?, NULL)").run(licenseId, id, OWNER_DEVICE_LIMIT)
    db.prepare("INSERT INTO users (id, email, password_hash, role, verified, license_id, setup_hash) VALUES (?, ?, NULL, 'owner', 0, ?, NULL)").run(id, OWNER_EMAIL, licenseId)
    owner = { id, password_hash: null, setup_hash: null }
  }
  if (!owner.password_hash && options.ownerSetupToken) {
    db.prepare("UPDATE users SET setup_hash = ? WHERE email = ? AND setup_hash IS NULL").run(sha(options.ownerSetupToken), OWNER_EMAIL)
  }
  if (!owner.password_hash && options.ownerPassword && options.ownerSetupToken) {
    setOwnerPassword(db, options.ownerSetupToken, options.ownerPassword)
  }
  // The owner role is the only unlimited seat. Startup clears any stored PC so an older cap cannot linger.
  db.prepare("UPDATE users SET account_status = 'active' WHERE email = ? AND role = 'owner'").run(OWNER_EMAIL)
  db.prepare("UPDATE licenses SET fingerprint = NULL, devices = '[]', fingerprint_confirmed = 0, status = 'active', expires_at = NULL WHERE id = (SELECT license_id FROM users WHERE email = ? AND role = 'owner')").run(OWNER_EMAIL)
}

export function setOwnerPassword(db: DatabaseSync, token: string, password: string): void {
  const owner = db.prepare("SELECT setup_hash, password_hash FROM users WHERE email = ?").get(OWNER_EMAIL) as { setup_hash: string | null; password_hash: string | null } | undefined
  if (!owner) throw new Error("The owner account is not on this server yet. Start the server once first.")
  if (owner.password_hash) throw new Error("The owner password is already set.")
  if (!owner.setup_hash || !safeEqual(owner.setup_hash, sha(token))) throw new Error("The setup token does not match.")
  if (password.length < 8) throw new Error("Use a password of at least 8 characters.")
  db.prepare("UPDATE users SET password_hash = ?, verified = 1, setup_hash = NULL WHERE email = ?").run(hashPassword(password), OWNER_EMAIL)
}

/** Replaces the saved owner password and signs out every existing owner session. No setup token. */
export function changeOwnerPassword(db: DatabaseSync, password: string): void {
  const owner = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(OWNER_EMAIL) as { id: string; password_hash: string | null } | undefined
  if (!owner) throw new Error("The owner account is not on this server yet. Start the server once first.")
  if (!owner.password_hash) throw new Error("The owner password is not set yet. Use set-password with the setup token.")
  const next = password.trim()
  if (next.length < 8) throw new Error("Use a password of at least 8 characters.")
  db.prepare("UPDATE users SET password_hash = ?, verified = 1 WHERE id = ?").run(hashPassword(next), owner.id)
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(owner.id)
}

function changeAdminPassword(db: DatabaseSync, user: UserRow, body: Record<string, unknown>): { status: number; body: string } {
  const current = text(body.currentPassword)
  const next = text(body.password)
  if (!user.password_hash || !verifyPassword(current, user.password_hash)) {
    return json(400, { ok: false, error: "That current password was not accepted." })
  }
  if (next === current) return json(400, { ok: false, error: "Choose a different password." })
  try {
    changeOwnerPassword(db, next)
  } catch (err) {
    return json(400, { ok: false, error: err instanceof Error ? err.message : "Could not change the password." })
  }
  return json(200, { ok: true })
}

function setupOwner(db: DatabaseSync, body: Record<string, unknown>, now: () => number): { status: number; body: string } {
  try {
    setOwnerPassword(db, text(body.token), text(body.password))
    return json(200, { ok: true, email: OWNER_EMAIL, verified: true, at: now() })
  } catch (err) {
    return json(400, { ok: false, error: err instanceof Error ? err.message : "Setup failed." })
  }
}

function signup(db: DatabaseSync, body: Record<string, unknown>, now: () => number, onSignup: () => void): { status: number; body: string } {
  const email = normalizeEmail(text(body.email))
  const password = text(body.password)
  if (!email.includes("@") || password.length < 8) return json(400, { ok: false, error: "Enter your email and a password of at least 8 characters." })
  if (email === OWNER_EMAIL) return json(400, { ok: false, error: "This email is reserved." })
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) return json(400, { ok: false, error: "That email already has an account. Sign in instead." })
  const userId = randomId()
  db.prepare("INSERT INTO users (id, email, password_hash, role, verified, license_id, setup_hash, created_at, account_status, payment_method, paid) VALUES (?, ?, ?, 'user', 1, NULL, NULL, ?, 'pending', 'Not configured', 0)").run(userId, email, hashPassword(password), now())
  onSignup()
  return issuePending(db, userId, now)
}

function claim(db: DatabaseSync, privateKey: string, body: Record<string, unknown>, now: () => number, onClaim: () => void): { status: number; body: string } {
  const email = normalizeEmail(text(body.email))
  const password = text(body.password)
  const key = text(body.key)
  const fingerprint = text(body.fingerprint)
  if (!email.includes("@") || password.length < 8 || !/^[0-9a-f]{64}$/.test(fingerprint) || key.length < 12) {
    return json(400, { ok: false, error: "Enter the license key, your email, and a password of at least 8 characters." })
  }
  if (email === OWNER_EMAIL) return json(400, { ok: false, error: "This email is reserved." })
  if (db.prepare("SELECT id FROM users WHERE email = ?").get(email)) return json(400, { ok: false, error: "That email already has an account. Sign in instead." })
  const license = db.prepare("SELECT * FROM licenses WHERE key_hash = ?").get(sha(key)) as LicenseRow | undefined
  if (!license) return json(400, { ok: false, error: "That license key was not found." })
  if (license.status === "draft") return json(400, { ok: false, error: "Give access to this license before it can be used." })
  if (license.status === "suspended") return json(400, { ok: false, error: "This license is suspended." })
  if (license.status === "revoked") return json(400, { ok: false, error: "This license was revoked." })
  if (license.user_id) return json(400, { ok: false, error: "That license key was already claimed." })
  if (license.expires_at !== null && license.expires_at <= now()) return json(400, { ok: false, error: "This license key has expired." })
  const userId = randomId()
  db.prepare("INSERT INTO users (id, email, password_hash, role, verified, license_id, setup_hash, created_at, account_status, payment_method, paid) VALUES (?, ?, ?, 'user', 1, ?, NULL, ?, 'active', 'Not configured', 0)").run(userId, email, hashPassword(password), license.id, now())
  db.prepare("UPDATE licenses SET user_id = ?, fingerprint = ?, devices = ?, last_seen = ?, status = 'active', fingerprint_confirmed = 0 WHERE id = ?").run(userId, fingerprint, JSON.stringify([fingerprint]), now(), license.id)
  onClaim()
  return issueSession(db, privateKey, userId, fingerprint, now)
}

function login(db: DatabaseSync, privateKey: string, body: Record<string, unknown>, ip: string, now: () => number, push?: LicenseApiOptions["push"]): { status: number; body: string } {
  const email = normalizeEmail(text(body.email))
  const password = text(body.password)
  const fingerprint = text(body.fingerprint)
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash) || !user.verified) {
    noteFailure(db, email, ip, now, push)
    return json(401, { ok: false, error: "That email and password did not match." })
  }
  if (user.role !== "owner") {
    if (user.account_status === "suspended") return json(403, { ok: false, error: "This account is suspended." })
    const license = licenseFor(db, user)
    if (license?.status === "suspended") return json(403, { ok: false, error: "This license is suspended." })
    if (license?.status === "revoked") return json(403, { ok: false, error: "This license was revoked." })
    if (!readyLicense(license)) return issuePending(db, user.id, now)
  }
  return bindAndIssue(db, privateKey, user, fingerprint, now, push)
}

function adminLogin(db: DatabaseSync, body: Record<string, unknown>, now: () => number): { status: number; body: string } {
  const email = normalizeEmail(text(body.email))
  const password = text(body.password)
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined
  if (!user || user.role !== "owner" || !user.verified || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return json(401, { ok: false, error: "That admin sign-in was not accepted." })
  }
  const token = randomBytes(32).toString("base64url")
  db.prepare("INSERT INTO sessions (token_hash, user_id, fingerprint, expires_at, kind) VALUES (?, ?, '', ?, 'admin')").run(sha(token), user.id, now() + ADMIN_MS)
  return json(200, { ok: true, token, expiresAt: now() + ADMIN_MS, email: user.email, role: "owner" })
}

function heartbeat(db: DatabaseSync, privateKey: string, body: Record<string, unknown>, now: () => number, push?: LicenseApiOptions["push"]): { status: number; body: string } {
  const session = sessionByToken(db, text(body.token), now())
  if (!session || session.kind !== "user") return json(401, { ok: false, error: "Sign in again." })
  const fingerprint = text(body.fingerprint)
  if (session.fingerprint && session.fingerprint !== fingerprint) {
    notify(db, push, "foreign_pc", "Different PC", "A signed-in session was used from a different PC.")
    return json(403, { ok: false, error: "This license is already active on another PC" })
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as unknown as UserRow
  if (user.role === "owner") return bindAndIssue(db, privateKey, user, fingerprint, now, push, "heartbeat")
  if (user.account_status === "suspended") return json(403, { ok: false, error: "This account is suspended." })
  const license = licenseFor(db, user)
  if (!readyLicense(license)) {
    if (license?.status === "suspended") return json(403, { ok: false, error: "This license is suspended." })
    if (license?.status === "revoked") return json(403, { ok: false, error: "This license was revoked." })
    return issuePending(db, user.id, now, text(body.token))
  }
  sweepExpiry(db, now, push)
  return bindAndIssue(db, privateKey, user, fingerprint, now, push, "heartbeat")
}

function redeem(db: DatabaseSync, privateKey: string, body: Record<string, unknown>, now: () => number, push?: LicenseApiOptions["push"]): { status: number; body: string } {
  const session = sessionByToken(db, text(body.token), now())
  if (!session || session.kind !== "user") return json(401, { ok: false, error: "Sign in again." })
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as UserRow | undefined
  if (!user) return json(401, { ok: false, error: "Sign in again." })
  if (user.role === "owner") return json(400, { ok: false, error: "The owner account already has a license." })
  if (user.account_status === "suspended") return json(403, { ok: false, error: "This account is suspended." })
  if (user.license_id) return json(400, { ok: false, error: "This account already has a license." })
  const key = text(body.key)
  const fingerprint = text(body.fingerprint)
  if (key.length < 12) return json(400, { ok: false, error: "Enter the gift key." })
  const license = db.prepare("SELECT * FROM licenses WHERE key_hash = ?").get(sha(key)) as LicenseRow | undefined
  if (!license) return json(400, { ok: false, error: "That license key was not found." })
  if (license.user_id) return json(400, { ok: false, error: "That license key was already claimed." })
  if (license.status === "draft") return json(400, { ok: false, error: "Give access to this license before it can be used." })
  if (license.status === "suspended") return json(400, { ok: false, error: "This license is suspended." })
  if (license.status === "revoked") return json(400, { ok: false, error: "This license was revoked." })
  if (license.expires_at !== null && license.expires_at <= now()) return json(400, { ok: false, error: "This license key has expired." })
  db.prepare("UPDATE licenses SET user_id = ? WHERE id = ?").run(user.id, license.id)
  db.prepare("UPDATE users SET license_id = ?, account_status = 'active' WHERE id = ?").run(license.id, user.id)
  notify(db, push, "claimed", "License claimed", `${user.email} redeemed a gift key.`)
  const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as unknown as UserRow
  return bindAndIssue(db, privateKey, updated, fingerprint, now, push)
}

function transfer(db: DatabaseSync, privateKey: string, body: Record<string, unknown>, now: () => number): { status: number; body: string } {
  const session = sessionByToken(db, text(body.token), now())
  if (!session || session.kind !== "user") return json(401, { ok: false, error: "Sign in again." })
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as unknown as UserRow
  if (user.role === "owner") return bindAndIssue(db, privateKey, user, text(body.fingerprint), now)
  const license = licenseFor(db, user)
  if (!license) return json(400, { ok: false, error: "This account has no license." })
  if (license.last_transfer_at && now() - license.last_transfer_at < TRANSFER_MS) {
    return json(400, { ok: false, error: "You can move this license to a new PC once every 30 days." })
  }
  const fingerprint = text(body.fingerprint)
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) return json(400, { ok: false, error: "This PC could not be recognized." })
  db.prepare("UPDATE licenses SET fingerprint = ?, devices = ?, last_transfer_at = ?, last_seen = ?, fingerprint_confirmed = 1 WHERE id = ?").run(fingerprint, JSON.stringify([fingerprint]), now(), now(), license.id)
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user'").run(user.id)
  return issueSession(db, privateKey, user.id, fingerprint, now)
}

function checkout(db: DatabaseSync, body: Record<string, unknown>, now: () => number, push?: LicenseApiOptions["push"]): { status: number; body: string } {
  const session = sessionByToken(db, text(body.token), now())
  if (!session || session.kind !== "user") return json(401, { ok: false, error: "Sign in again." })
  const store = text(body.store).slice(0, 40)
  const sku = text(body.sku).slice(0, 80)
  if (!store || !sku) return json(400, { ok: false, error: "Say which store and product checked out." })
  const enabled = db.prepare("SELECT enabled FROM notifications WHERE type = 'checkout'").get() as { enabled: number }
  if (enabled?.enabled) notify(db, push, "checkout", "Checkout succeeded", `${store} ${sku}`)
  return json(200, { ok: true })
}

function issuePending(db: DatabaseSync, userId: string, now: () => number, existingToken = ""): { status: number; body: string } {
  const user = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as { email: string } | undefined
  if (!user) return json(400, { ok: false, error: "That account was not found." })
  const current = existingToken ? sessionByToken(db, existingToken, now()) : null
  if (current && current.user_id === userId && current.kind === "user") {
    return json(200, { ok: true, pending: true, token: existingToken, email: user.email, status: "pending" })
  }
  const token = randomBytes(32).toString("base64url")
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user'").run(userId)
  db.prepare("INSERT INTO sessions (token_hash, user_id, fingerprint, expires_at, kind) VALUES (?, ?, '', ?, 'user')").run(sha(token), userId, now() + SESSION_MS)
  return json(200, { ok: true, pending: true, token, email: user.email, status: "pending" })
}

function readyLicense(license: LicenseRow | undefined): boolean {
  return license?.status === "active"
}

function createLicense(db: DatabaseSync, body: Record<string, unknown>, now: () => number): { status: number; body: string } {
  const note = text(body.note).slice(0, 80)
  const plan = text(body.plan).slice(0, 40) || "standard"
  if (!isPlanId(plan)) return json(400, { ok: false, error: `Pick a plan: ${PLAN_IDS.join(" or ")}.` })
  const expiresAt = body.expiresAt === undefined || body.expiresAt === null || body.expiresAt === "" ? now() + YEAR_MS : Number(body.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt < now()) return json(400, { ok: false, error: "Expiry has to be a future time." })
  const id = randomId()
  const key = `TCGAIO-${randomBytes(16).toString("hex")}`
  db.prepare("INSERT INTO licenses (id, key_hash, note, plan, expires_at, status, fingerprint, devices, last_seen, user_id, last_transfer_at, device_limit, last_expiry_alert) VALUES (?, ?, ?, ?, ?, 'draft', NULL, '[]', NULL, NULL, NULL, ?, NULL)").run(id, sha(key), note, plan, expiresAt, USER_DEVICE_LIMIT)
  return json(200, { ok: true, id, key, note, plan, expiresAt, status: "draft" })
}

function licenseOwnerRole(db: DatabaseSync, license: LicenseRow): string {
  const owner = db.prepare("SELECT role FROM users WHERE id = ?").get(license.user_id ?? "") as { role: string } | undefined
  return license.plan === "owner" ? "owner" : owner?.role ?? ""
}

/** Change a license's plan. The PC picks up the new feature list at its next check-in. */
function changePlan(db: DatabaseSync, id: string, body: Record<string, unknown>): { status: number; body: string } {
  const license = db.prepare("SELECT * FROM licenses WHERE id = ?").get(id) as LicenseRow | undefined
  if (!license) return json(404, { ok: false, error: "That license was not found." })
  if (licenseOwnerRole(db, license) === "owner") return json(403, { ok: false, error: "The owner license always has every feature." })
  const plan = text(body.plan)
  if (!isPlanId(plan)) return json(400, { ok: false, error: `Pick a plan: ${PLAN_IDS.join(" or ")}.` })
  db.prepare("UPDATE licenses SET plan = ? WHERE id = ?").run(plan, id)
  return json(200, { ok: true, id, plan })
}

/**
 * Delete a key. The customer loses access right away (their sessions end) but their account stays,
 * back in pending, so a new key can be linked later. The owner's key cannot be deleted.
 */
function deleteLicense(db: DatabaseSync, id: string, by: string, now: () => number): { status: number; body: string } {
  const license = db.prepare("SELECT * FROM licenses WHERE id = ?").get(id) as LicenseRow | undefined
  if (!license) return json(404, { ok: false, error: "That license was not found." })
  if (licenseOwnerRole(db, license) === "owner") return json(403, { ok: false, error: "The owner license cannot be deleted." })
  const users = db.prepare("SELECT id, email FROM users WHERE license_id = ?").all(id) as Array<{ id: string; email: string }>
  for (const user of users) {
    db.prepare("UPDATE users SET license_id = NULL, account_status = CASE WHEN account_status = 'suspended' THEN 'suspended' ELSE 'pending' END WHERE id = ?").run(user.id)
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user'").run(user.id)
  }
  if (license.user_id) db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user'").run(license.user_id)
  db.prepare("DELETE FROM licenses WHERE id = ?").run(id)
  db.prepare("INSERT INTO alerts (type, body, created_at) VALUES ('revoked', ?, ?)").run(`Key deleted by ${by}: ${license.note || license.id}${users.length ? ` (${users.map((u) => u.email).join(", ")} back to pending)` : ""}`, now())
  return json(200, { ok: true, id, deleted: true, pending: users.map((u) => u.email) })
}

function licenseAction(db: DatabaseSync, id: string, action: string, push?: LicenseApiOptions["push"]): { status: number; body: string } {
  const license = db.prepare("SELECT * FROM licenses WHERE id = ?").get(id) as LicenseRow | undefined
  if (!license) return json(404, { ok: false, error: "That license was not found." })
  const owner = db.prepare("SELECT role FROM users WHERE id = ?").get(license.user_id ?? "") as { role: string } | undefined
  if (owner?.role === "owner" && (action === "reset" || action === "suspend" || action === "revoke")) {
    return json(403, { ok: false, error: "The owner license cannot be reset, suspended, or revoked." })
  }
  if (action === "access") {
    if (license.status === "revoked") return json(400, { ok: false, error: "A revoked license stays revoked." })
    db.prepare("UPDATE licenses SET status = 'active' WHERE id = ?").run(id)
  } else if (action === "reset") {
    db.prepare("UPDATE licenses SET fingerprint = NULL, devices = '[]', fingerprint_confirmed = 0 WHERE id = ?").run(id)
    if (license.user_id) db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user'").run(license.user_id)
  } else if (action === "suspend") {
    db.prepare("UPDATE licenses SET status = 'suspended' WHERE id = ?").run(id)
    notify(db, push, "suspended", "License suspended", license.note || license.id)
  } else if (action === "revoke") {
    db.prepare("UPDATE licenses SET status = 'revoked' WHERE id = ?").run(id)
    notify(db, push, "revoked", "License revoked", license.note || license.id)
  }
  return json(200, { ok: true, id, status: action === "access" ? "active" : action === "reset" ? license.status : action === "suspend" ? "suspended" : "revoked" })
}

function userAction(db: DatabaseSync, id: string, action: string, body: Record<string, unknown>, now: () => number, push?: LicenseApiOptions["push"]): { status: number; body: string } {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined
  if (!user) return json(404, { ok: false, error: "That account was not found." })
  if (user.role === "owner") return json(403, { ok: false, error: "The owner account stays active." })
  if (action === "license") return linkGeneratedLicense(db, user, body, now)
  if (action === "paid") {
    if (typeof body.paid !== "boolean") return json(400, { ok: false, error: "Say whether this account is paid." })
    db.prepare("UPDATE users SET paid = ? WHERE id = ?").run(body.paid ? 1 : 0, id)
    return json(200, { ok: true, id, paid: body.paid })
  }
  if (action === "payment") {
    const paymentMethod = text(body.paymentMethod).slice(0, 80) || "Not configured"
    db.prepare("UPDATE users SET payment_method = ? WHERE id = ?").run(paymentMethod, id)
    return json(200, { ok: true, id, paymentMethod })
  }
  if (action === "suspend") {
    db.prepare("UPDATE users SET account_status = 'suspended' WHERE id = ?").run(id)
    if (user.license_id) db.prepare("UPDATE licenses SET status = 'suspended' WHERE id = ? AND status != 'revoked'").run(user.license_id)
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user'").run(id)
    notify(db, push, "suspended", "Account suspended", user.email)
    return json(200, { ok: true, id, status: "suspended" })
  }
  if (action === "unsuspend") {
    const license = licenseFor(db, user)
    const next = license && license.status !== "revoked" ? "active" : "pending"
    db.prepare("UPDATE users SET account_status = ? WHERE id = ?").run(next, id)
    if (license?.status === "suspended") db.prepare("UPDATE licenses SET status = 'active' WHERE id = ?").run(license.id)
    return json(200, { ok: true, id, status: next })
  }
  if (!user.license_id) return json(400, { ok: false, error: "This account has no license to reset." })
  return licenseAction(db, user.license_id, "reset", push)
}

function linkGeneratedLicense(db: DatabaseSync, user: UserRow, body: Record<string, unknown>, now: () => number): { status: number; body: string } {
  if (user.license_id) return json(400, { ok: false, error: "This account already has a license." })
  const note = text(body.note).slice(0, 80) || user.email
  const plan = text(body.plan).slice(0, 40) || "standard"
  if (!isPlanId(plan)) return json(400, { ok: false, error: `Pick a plan: ${PLAN_IDS.join(" or ")}.` })
  const expiresAt = body.expiresAt === undefined || body.expiresAt === null || body.expiresAt === "" ? now() + YEAR_MS : Number(body.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt < now()) return json(400, { ok: false, error: "Expiry has to be a future time." })
  const id = randomId()
  const key = `TCGAIO-${randomBytes(16).toString("hex")}`
  const suspended = user.account_status === "suspended"
  db.prepare("INSERT INTO licenses (id, key_hash, note, plan, expires_at, status, fingerprint, devices, last_seen, user_id, last_transfer_at, device_limit, last_expiry_alert) VALUES (?, ?, ?, ?, ?, ?, NULL, '[]', NULL, ?, NULL, ?, NULL)").run(id, sha(key), note, plan, expiresAt, suspended ? "suspended" : "active", user.id, USER_DEVICE_LIMIT)
  if (!suspended) db.prepare("UPDATE users SET license_id = ?, account_status = 'active' WHERE id = ?").run(id, user.id)
  else db.prepare("UPDATE users SET license_id = ? WHERE id = ?").run(id, user.id)
  return json(200, { ok: true, id, key, email: user.email, status: suspended ? "suspended" : "active", fingerprint: "" })
}

function listUsers(db: DatabaseSync, query: string, status: string): { users: unknown[]; pendingCount: number; activeCount: number; suspendedCount: number; giftCount: number } {
  const needle = query.trim().toLowerCase()
  const wanted = status.trim().toLowerCase()
  const rows = db.prepare(`SELECT users.id, users.email, users.role, users.created_at, users.account_status, users.payment_method, users.paid, users.license_id,
      licenses.status AS license_status, licenses.fingerprint, licenses.last_seen, licenses.plan
    FROM users LEFT JOIN licenses ON licenses.id = users.license_id
    ORDER BY CASE users.account_status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, users.created_at DESC`).all() as unknown as UserListRow[]
  const pendingCount = rows.filter((row) => row.account_status === "pending").length
  const activeCount = rows.filter((row) => row.account_status === "active").length
  const suspendedCount = rows.filter((row) => row.account_status === "suspended").length
  const giftRow = db.prepare("SELECT COUNT(*) AS n FROM licenses WHERE user_id IS NULL").get() as { n: number } | undefined
  const giftCount = Number(giftRow?.n ?? 0)
  const users = rows.filter((row) => {
    if (wanted && row.account_status !== wanted) return false
    if (!needle) return true
    return `${row.email} ${row.payment_method} ${row.account_status}`.toLowerCase().includes(needle)
  }).map(publicUser)
  return { users, pendingCount, activeCount, suspendedCount, giftCount }
}

function publicUser(row: UserListRow) {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
    status: row.account_status,
    paymentMethod: row.payment_method || "Not configured",
    paid: row.paid === 1,
    licenseId: row.license_id ?? "",
    licenseStatus: row.license_status ?? "",
    plan: row.plan ?? "",
    fingerprint: row.fingerprint ? row.fingerprint.slice(0, 12) : "",
    lastSeen: row.last_seen
  }
}

function mintAdminDownloadTicket(db: DatabaseSync, at: number): { token: string; expiresAt: number } {
  db.prepare("DELETE FROM admin_download_tickets WHERE expires_at <= ?").run(at)
  const token = randomBytes(32).toString("base64url")
  const expiresAt = at + 2 * 60 * 1000
  db.prepare("INSERT INTO admin_download_tickets (token_hash, expires_at) VALUES (?, ?)").run(sha(token), expiresAt)
  return { token, expiresAt }
}

function takeAdminDownloadTicket(db: DatabaseSync, token: string, at: number): boolean {
  const hash = sha(token.trim())
  const row = db.prepare("SELECT expires_at FROM admin_download_tickets WHERE token_hash = ?").get(hash) as { expires_at: number } | undefined
  db.prepare("DELETE FROM admin_download_tickets WHERE token_hash = ?").run(hash)
  return Boolean(row && row.expires_at > at)
}

function adminRelease(db: DatabaseSync): { version: string; versionCode: number; size: number; available: boolean; notes: string; file?: string } {
  const version = meta(db, "adminApkVersion")
  const versionCode = Number(meta(db, "adminApkVersionCode") || "0")
  const file = meta(db, "adminApkFile")
  const size = Number(meta(db, "adminApkSize") || "0")
  const available = Boolean(version && file && existsSync(file))
  return { version, versionCode: Number.isFinite(versionCode) ? versionCode : 0, size: available ? size : 0, available, notes: meta(db, "adminApkNotes"), file: available ? file : undefined }
}

function relayUser(db: DatabaseSync, headers: Record<string, string | undefined>, body: Record<string, unknown>, at: number): string | null {
  const header = headers.authorization ?? headers.Authorization ?? ""
  const match = /^Bearer\s+(\S+)$/.exec(header)
  const token = match?.[1] || text(body.token)
  const session = sessionByToken(db, token, at)
  if (!session || session.kind !== "user") return null
  return session.user_id
}

function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value)
}

function meta(db: DatabaseSync, key: string): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
  return row?.value ?? ""
}

function overview(db: DatabaseSync, query: string, now: () => number): { licenses: unknown[]; users: unknown[]; pendingCount: number; activeCount: number; suspendedCount: number; giftCount: number } {
  sweepExpiry(db, now)
  const needle = query.trim().toLowerCase()
  const licenses = (db.prepare("SELECT * FROM licenses ORDER BY rowid DESC").all() as unknown as LicenseRow[]).filter((row) => {
    if (!needle) return true
    return `${row.note} ${row.plan} ${row.id} ${row.fingerprint ?? ""} ${row.status}`.toLowerCase().includes(needle)
  }).map((row) => {
    const user = row.user_id ? db.prepare("SELECT email, role FROM users WHERE id = ?").get(row.user_id) as { email: string; role: string } | undefined : undefined
    return {
      id: row.id,
      note: row.note,
      plan: row.plan,
      status: row.status,
      email: user?.email ?? "",
      role: user?.role ?? "",
      expiresAt: row.expires_at,
      fingerprint: row.fingerprint ? row.fingerprint.slice(0, 12) : "",
      lastSeen: row.last_seen,
      deviceLimit: row.device_limit
    }
  })
  const listed = listUsers(db, needle, "")
  return { licenses, users: listed.users, pendingCount: listed.pendingCount, activeCount: listed.activeCount, suspendedCount: listed.suspendedCount, giftCount: listed.giftCount }
}

function confirmSession(db: DatabaseSync, body: Record<string, unknown>, now: () => number, push?: LicenseApiOptions["push"]): { status: number; body: string } {
  const session = sessionByToken(db, text(body.token), now())
  if (!session || session.kind !== "user") return json(401, { ok: false, error: "Sign in again." })
  if (!/^[0-9a-f]{64}$/.test(session.fingerprint)) return json(400, { ok: false, error: "This PC could not be recognized." })
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as UserRow | undefined
  if (!user) return json(401, { ok: false, error: "Sign in again." })
  const license = licenseFor(db, user)
  if (user.role === "owner") {
    if (!license) return json(400, { ok: false, error: "This account has no license." })
    releaseOwner(db, user.id, license.id, now())
    return json(200, { ok: true })
  }
  const blocked = licenseBlock(license, now())
  if (blocked) return blocked
  const rejected = lockDevice(db, user, license as LicenseRow, session.fingerprint, now(), push)
  if (rejected) return rejected
  return json(200, { ok: true })
}

function licenseBlock(license: LicenseRow | undefined, at: number): { status: number; body: string } | null {
  if (!license) return json(400, { ok: false, error: "This account has no license." })
  if (license.status === "suspended") return json(403, { ok: false, error: "This license is suspended." })
  if (license.status === "revoked") return json(403, { ok: false, error: "This license was revoked." })
  if (license.status !== "active") return json(403, { ok: false, error: "Give access to this license before it can be used." })
  if (license.expires_at !== null && license.expires_at <= at) return json(403, { ok: false, error: "This license key has expired." })
  return null
}

function releaseOwner(db: DatabaseSync, userId: string, licenseId: string, at: number): void {
  db.prepare("UPDATE users SET account_status = 'active' WHERE id = ? AND role = 'owner'").run(userId)
  db.prepare("UPDATE licenses SET fingerprint = NULL, devices = '[]', fingerprint_confirmed = 0, status = 'active', expires_at = NULL, last_seen = ? WHERE id = ?").run(at, licenseId)
}

function lockDevice(db: DatabaseSync, user: UserRow, license: LicenseRow, fingerprint: string, at: number, push?: LicenseApiOptions["push"]): { status: number; body: string } | null {
  if (user.role === "owner") return null
  if (license.fingerprint && license.fingerprint !== fingerprint) {
    notify(db, push, "foreign_pc", "Different PC", "Someone tried to use a license from a different PC.")
    return json(403, { ok: false, error: "This license is already active on another PC" })
  }
  db.prepare("UPDATE licenses SET fingerprint = ?, devices = ?, fingerprint_confirmed = 1, last_seen = ? WHERE id = ?").run(fingerprint, JSON.stringify([fingerprint]), at, license.id)
  return null
}

function bindAndIssue(db: DatabaseSync, privateKey: string, user: UserRow, fingerprint: string, now: () => number, push?: LicenseApiOptions["push"], mode: "login" | "heartbeat" = "login"): { status: number; body: string } {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) return json(400, { ok: false, error: "This PC could not be recognized." })
  const license = licenseFor(db, user)
  if (user.role === "owner") {
    if (!license) return json(400, { ok: false, error: "This account has no license." })
    releaseOwner(db, user.id, license.id, now())
    return issueSession(db, privateKey, user.id, fingerprint, now, true)
  }
  const blocked = licenseBlock(license, now())
  if (blocked) return blocked
  const row = license as LicenseRow
  if (mode === "heartbeat") {
    const rejected = lockDevice(db, user, row, fingerprint, now(), push)
    if (rejected) return rejected
  } else {
    const confirmed = Number(row.fingerprint_confirmed ?? 1) === 1
    if (row.fingerprint && row.fingerprint !== fingerprint && confirmed) {
      notify(db, push, "foreign_pc", "Different PC", "Someone tried to use a license from a different PC.")
      return json(403, { ok: false, error: "This license is already active on another PC" })
    }
    const keep = row.fingerprint === fingerprint && confirmed ? 1 : 0
    db.prepare("UPDATE licenses SET fingerprint = ?, devices = ?, fingerprint_confirmed = ?, last_seen = ? WHERE id = ?").run(fingerprint, JSON.stringify([fingerprint]), keep, now(), row.id)
  }
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user' AND fingerprint != ?").run(user.id, fingerprint)
  return issueSession(db, privateKey, user.id, fingerprint, now)
}

function issueSession(db: DatabaseSync, privateKey: string, userId: string, fingerprint: string, now: () => number, keepOtherPcs = false): { status: number; body: string } {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as unknown as UserRow
  const license = licenseFor(db, user)
  if (!license) return json(400, { ok: false, error: "This account has no license." })
  const owner = user.role === "owner"
  const token = randomBytes(32).toString("base64url")
  if (owner && keepOtherPcs) db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user' AND fingerprint = ?").run(userId, fingerprint)
  else db.prepare("DELETE FROM sessions WHERE user_id = ? AND kind = 'user'").run(userId)
  db.prepare("INSERT INTO sessions (token_hash, user_id, fingerprint, expires_at, kind) VALUES (?, ?, ?, ?, 'user')").run(sha(token), userId, fingerprint, now() + SESSION_MS)
  const grant: AccessGrant = {
    v: 1,
    ok: true,
    email: user.email,
    role: owner ? "owner" : "user",
    licenseId: license.id,
    holder: license.note || user.email,
    plan: owner ? "owner" : license.plan,
    features: featuresForPlan(owner ? "owner" : license.plan),
    expiresAt: owner ? null : license.expires_at,
    fingerprint,
    serverTime: now(),
    graceMs: GRANT_GRACE_MS
  }
  return json(200, { ok: true, token, envelope: signEnvelope(privateKey, grant) })
}

function notificationMap(db: DatabaseSync): Record<string, boolean> {
  const rows = db.prepare("SELECT type, enabled FROM notifications").all() as Array<{ type: string; enabled: number }>
  return Object.fromEntries(rows.map((row) => [row.type, row.enabled === 1]))
}

function saveNotifications(db: DatabaseSync, body: Record<string, unknown>): { status: number; body: string } {
  for (const type of ALERT_TYPES) {
    if (typeof body[type] === "boolean") db.prepare("UPDATE notifications SET enabled = ? WHERE type = ?").run(body[type] ? 1 : 0, type)
  }
  return json(200, { ok: true, notifications: notificationMap(db) })
}

function savePush(db: DatabaseSync, userId: string, body: Record<string, unknown>): { status: number; body: string } {
  const token = text(body.token)
  if (!token.startsWith("ExponentPushToken[") && !token.startsWith("ExpoPushToken[")) return json(400, { ok: false, error: "That push token was not recognized." })
  db.prepare("INSERT INTO push_tokens (token, user_id) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id").run(token.slice(0, 200), userId)
  return json(200, { ok: true })
}

function notify(db: DatabaseSync, push: LicenseApiOptions["push"], type: AlertType, title: string, body: string): void {
  const row = db.prepare("SELECT enabled FROM notifications WHERE type = ?").get(type) as { enabled: number } | undefined
  if (!row?.enabled) return
  db.prepare("INSERT INTO alerts (type, body, created_at) VALUES (?, ?, ?)").run(type, body.slice(0, 180), Date.now())
  push?.({ title, body: body.slice(0, 180), type })
  void sendExpo(db, title, body.slice(0, 180), type)
}

async function sendExpo(db: DatabaseSync, title: string, body: string, type: AlertType): Promise<void> {
  const access = process.env.EXPO_ACCESS_TOKEN?.trim()
  if (!access) return
  const tokens = db.prepare("SELECT token FROM push_tokens").all() as Array<{ token: string }>
  if (!tokens.length) return
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${access}` },
      body: JSON.stringify(tokens.map((row) => ({ to: row.token, title, body, data: { type } })))
    })
  } catch {
    // The alert is already stored. Push can fail when the phone is offline.
  }
}

function noteFailure(db: DatabaseSync, email: string, ip: string, now: () => number, push?: LicenseApiOptions["push"]): void {
  const at = now()
  db.prepare("INSERT INTO login_failures (email, ip, at) VALUES (?, ?, ?)").run(email, ip, at)
  const recent = db.prepare("SELECT COUNT(*) AS count FROM login_failures WHERE email = ? AND at > ?").get(email, at - 15 * 60 * 1000) as { count: number }
  if (recent.count >= FAIL_ALERT) notify(db, push, "failed_logins", "Repeated failed sign-ins", `Several sign-in attempts failed for ${email || "an unknown email"}.`)
}

function sweepExpiry(db: DatabaseSync, now: () => number, push?: LicenseApiOptions["push"]): void {
  const soon = now() + 7 * 24 * 60 * 60 * 1000
  const rows = db.prepare("SELECT id, note, expires_at, last_expiry_alert FROM licenses WHERE expires_at IS NOT NULL AND expires_at < ? AND status = 'active'").all(soon) as Array<{ id: string; note: string; expires_at: number; last_expiry_alert: number | null }>
  for (const row of rows) {
    if (row.last_expiry_alert && now() - row.last_expiry_alert < 24 * 60 * 60 * 1000) continue
    db.prepare("UPDATE licenses SET last_expiry_alert = ? WHERE id = ?").run(now(), row.id)
    notify(db, push, "expiring", "License expiring", `${row.note || row.id} expires soon.`)
  }
}

function takeRate(rates: Map<string, { count: number; resetAt: number }>, bucket: string, at: number): boolean {
  const current = rates.get(bucket)
  if (!current || current.resetAt <= at) {
    rates.set(bucket, { count: 1, resetAt: at + RATE_WINDOW_MS })
    return true
  }
  if (current.count >= RATE_LIMIT) return false
  current.count += 1
  return true
}

function adminUser(db: DatabaseSync, headers: Record<string, string | undefined>, at: number): UserRow | null {
  const header = headers.authorization ?? headers.Authorization ?? ""
  const match = /^Bearer\s+(\S+)$/.exec(header)
  if (!match) return null
  const session = db.prepare("SELECT user_id, expires_at, kind FROM sessions WHERE token_hash = ?").get(sha(match[1])) as { user_id: string; expires_at: number; kind: string } | undefined
  if (!session || session.kind !== "admin" || session.expires_at <= at) return null
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id) as UserRow | undefined
  if (!user || user.role !== "owner") return null
  return user
}

function sessionByToken(db: DatabaseSync, token: string, at: number): { user_id: string; fingerprint: string; kind: string } | null {
  if (!token) return null
  const session = db.prepare("SELECT user_id, fingerprint, expires_at, kind FROM sessions WHERE token_hash = ?").get(sha(token)) as { user_id: string; fingerprint: string; expires_at: number; kind: string } | undefined
  if (!session || session.expires_at <= at) return null
  return session
}

function licenseFor(db: DatabaseSync, user: UserRow): LicenseRow | undefined {
  if (!user.license_id) return undefined
  return db.prepare("SELECT * FROM licenses WHERE id = ?").get(user.license_id) as LicenseRow | undefined
}

function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = argon2id(Buffer.from(password), salt, ARGON)
  return `argon2id:${Buffer.from(salt).toString("hex")}:${Buffer.from(hash).toString("hex")}`
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(":")
  if (parts.length !== 3 || parts[0] !== "argon2id" || !parts[1] || !parts[2]) return false
  const salt = Buffer.from(parts[1], "hex")
  const expected = Buffer.from(parts[2], "hex")
  const actual = Buffer.from(argon2id(Buffer.from(password), salt, ARGON))
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function normalizeUploadToken(value: string): string {
  let text = value
  for (let pass = 0; pass < 4; pass += 1) {
    const next = unwrapUploadToken(text)
    if (next === text) break
    text = next
  }
  return text.replace(/\s+/g, "")
}

function unwrapUploadToken(value: string): string {
  let text = value.trim().replace(/^\uFEFF/, "")
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1)
  text = text.replace(/^TCGAIO_ADMIN_UPLOAD_TOKEN=/i, "")
  text = text.replace(/^Bearer\s+/i, "")
  return text.trim()
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase()
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function randomId(): string {
  return randomBytes(16).toString("hex")
}

function json(status: number, body: unknown): { status: number; body: string } {
  return { status, body: JSON.stringify(body) }
}

const REQUEST_SECRETS = ["cardnumber", "card", "cvv", "cookie", "cookies", "session", "pan", "proxy", "accesstoken"]

function requestHasSecret(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  for (const [key, child] of Object.entries(value)) {
    if (REQUEST_SECRETS.includes(key.toLowerCase())) return true
    if (requestHasSecret(child)) return true
  }
  return false
}

function parseObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("License JSON could not be parsed.")
  return parsed as Record<string, unknown>
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(req.headers)) headers[key] = Array.isArray(value) ? value[0] : value
  return headers
}

interface UserRow {
  id: string
  email: string
  password_hash: string | null
  role: string
  verified: number
  license_id: string | null
  account_status: string
  created_at: number
  payment_method: string
  paid: number
}

interface UserListRow {
  id: string
  email: string
  role: string
  created_at: number
  account_status: string
  payment_method: string
  paid: number
  license_id: string | null
  license_status: string | null
  fingerprint: string | null
  last_seen: number | null
  plan: string | null
}

interface LicenseRow {
  id: string
  note: string
  plan: string
  expires_at: number | null
  status: string
  fingerprint: string | null
  devices: string
  last_seen: number | null
  user_id: string | null
  last_transfer_at: number | null
  device_limit: number
  fingerprint_confirmed: number
}
