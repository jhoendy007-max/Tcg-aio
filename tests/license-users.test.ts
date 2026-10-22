import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { OWNER_EMAIL, openLicenseApi, type LicenseApi } from "../license-server/server"
import { fingerprintHash, readGrant } from "../src/shared/license-proof"

const fingerprintA = fingerprintHash(["machine-guid-a", "board-a"])
const fingerprintB = fingerprintHash(["machine-guid-b", "board-b"])

function api(extra: { push?: (message: { type: string }) => void; adminUploadToken?: string } = {}): LicenseApi {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-users-"))
  return openLicenseApi({
    dbPath: join(dir, "license.sqlite"),
    ownerSetupToken: "setup-token-value",
    ownerPassword: "owner-password",
    adminUploadToken: extra.adminUploadToken,
    push: extra.push
  })
}

function post(server: LicenseApi, path: string, body: unknown, token = "") {
  return server.handle("POST", path, token ? { authorization: `Bearer ${token}` } : {}, JSON.stringify(body))
}

function get(server: LicenseApi, path: string, token = "") {
  return server.handle("GET", path, token ? { authorization: `Bearer ${token}` } : {}, "")
}

function json(result: { body: string }): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>
}

describe("pending accounts and admin updates", () => {
  const open: LicenseApi[] = []
  afterEach(() => {
    for (const item of open) item.close()
    open.length = 0
  })

  it("keeps a signup pending until a license is linked, then binds the first PC", () => {
    const pushes: string[] = []
    const server = api({ push: (message) => pushes.push(message.type) })
    open.push(server)
    const created = json(post(server, "/v1/account/signup", { email: "ada@example.com", password: "password1" }))
    expect(created.pending).toBe(true)
    expect(created.envelope).toBeUndefined()
    expect(pushes).toContain("signup")
    const waiting = json(post(server, "/v1/session/heartbeat", { token: created.token, fingerprint: fingerprintA }))
    expect(waiting.pending).toBe(true)
    expect(waiting.token).toBe(created.token)

    const admin = json(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    const listed = json(get(server, "/v1/admin/users?status=pending", String(admin.token)))
    expect(listed.pendingCount).toBe(1)
    expect(listed.activeCount).toBe(1)
    expect(listed.suspendedCount).toBe(0)
    expect(listed.giftCount).toBe(0)
    const row = (listed.users as Array<{ id: string; email: string; status: string; paymentMethod: string; paid: boolean; createdAt: number }>)[0]
    expect(row.email).toBe("ada@example.com")
    expect(row.status).toBe("pending")
    expect(row.paymentMethod).toBe("Not configured")
    expect(row.paid).toBe(false)
    expect(row.createdAt).toBeGreaterThan(0)

    const paid = json(post(server, `/v1/admin/users/${row.id}/paid`, { paid: true }, String(admin.token)))
    expect(paid.paid).toBe(true)
    const linked = json(post(server, `/v1/admin/users/${row.id}/license`, { note: "Ada" }, String(admin.token)))
    expect(linked.status).toBe("active")
    expect(linked.fingerprint).toBe("")
    expect(String(linked.key)).toMatch(/^TCGAIO-/)
    const beforeLogin = json(get(server, "/v1/admin/users?status=active", String(admin.token)))
    const active = (beforeLogin.users as Array<{ email: string; fingerprint: string; paid: boolean }>).find((item) => item.email === "ada@example.com")
    expect(active?.fingerprint).toBe("")
    expect(active?.paid).toBe(true)

    const first = json(post(server, "/v1/account/login", { email: "ada@example.com", password: "password1", fingerprint: fingerprintA }))
    const grant = readGrant(String(first.envelope), server.publicKey)
    expect(grant?.fingerprint).toBe(fingerprintA)
    expect(grant?.role).toBe("user")
    expect(post(server, "/v1/session/confirm", { token: first.token }).status).toBe(200)
    const second = post(server, "/v1/account/login", { email: "ada@example.com", password: "password1", fingerprint: fingerprintB })
    expect(second.status).toBe(403)
    expect(second.body).toContain("This license is already active on another PC")
  })

  it("lets a customer redeem a standalone gift key", () => {
    const server = api()
    open.push(server)
    const created = json(post(server, "/v1/account/signup", { email: "ada@example.com", password: "password1" }))
    const admin = json(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    const gift = json(post(server, "/v1/admin/licenses", { note: "Gift" }, String(admin.token)))
    expect(gift.status).toBe("draft")
    const early = post(server, "/v1/account/redeem", { token: created.token, key: gift.key, fingerprint: fingerprintA })
    expect(early.status).toBe(400)
    post(server, `/v1/admin/licenses/${gift.id}/access`, {}, String(admin.token))
    const redeemed = json(post(server, "/v1/account/redeem", { token: created.token, key: gift.key, fingerprint: fingerprintA }))
    expect(readGrant(String(redeemed.envelope), server.publicKey)?.fingerprint).toBe(fingerprintA)
    const other = json(post(server, "/v1/account/signup", { email: "bea@example.com", password: "password1" }))
    const again = post(server, "/v1/account/redeem", { token: other.token, key: gift.key, fingerprint: fingerprintB })
    expect(again.status).toBe(400)
    expect(again.body).toContain("already claimed")
  })

  it("serves the admin APK only to the owner and only with the upload token", () => {
    const server = api({ adminUploadToken: "upload-token" })
    open.push(server)
    expect(get(server, "/v1/admin/app").status).toBe(401)
    const admin = json(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    expect(json(get(server, "/v1/admin/app", String(admin.token))).available).toBe(false)
    const bytes = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(80, 1)])
    const rejected = server.storeAdminApk({ version: "0.2.26", versionCode: 226, bytes, authorization: "Bearer wrong" })
    expect(rejected.status).toBe(401)
    expect(rejected.body).not.toContain("wrong")
    expect(rejected.body).not.toContain("upload-token")
    const stored = json(server.storeAdminApk({ version: "0.2.26", versionCode: 226, bytes, authorization: 'Bearer "upload-token"' }))
    expect(stored.ok).toBe(true)
    const quoted = api({ adminUploadToken: ' TCGAIO_ADMIN_UPLOAD_TOKEN="Bearer upload-token" ' })
    open.push(quoted)
    expect(json(quoted.storeAdminApk({ version: "0.2.26", versionCode: 226, bytes, authorization: "upload-token" })).ok).toBe(true)
    const normalized = spawnSync(process.execPath, ["scripts/normalize-upload-token.mjs"], {
      encoding: "utf8",
      env: { ...process.env, TCGAIO_ADMIN_UPLOAD_TOKEN: ' "Bearer upload-token" \n' }
    })
    expect(normalized.stdout).toBe("upload-token")
    expect(normalized.stderr ?? "").toBe("")
    const release = json(get(server, "/v1/admin/app", String(admin.token)))
    expect(release.available).toBe(true)
    expect(release.version).toBe("0.2.26")
    expect(release.versionCode).toBe(226)
    expect(release.notes).toBe("Admin 0.2.26")
    expect(JSON.stringify(release)).not.toContain("tcgaio-admin.apk")
    expect(json(server.storeAdminApk({ version: "0.2.26", versionCode: 226, bytes, authorization: 'Bearer "upload-token"', notes: "Anonymous monitors.\nRelay pairing." })).ok).toBe(true)
    expect(json(get(server, "/v1/admin/app", String(admin.token))).notes).toBe("Anonymous monitors. Relay pairing.")
    const customer = json(post(server, "/v1/account/signup", { email: "ada@example.com", password: "password1" }))
    expect(get(server, "/v1/admin/app", String(customer.token)).status).toBe(401)
    expect(server.adminDownload({}).status).toBe(401)
    const download = server.adminDownload({ authorization: `Bearer ${admin.token}` })
    expect(download.status).toBe(200)
    expect(download.file).toBeTruthy()

    const closed = api({ adminUploadToken: "" })
    open.push(closed)
    const skipped = closed.storeAdminApk({ version: "0.2.26", versionCode: 226, bytes, authorization: "Bearer upload-token" })
    expect(skipped.status).toBe(404)
  })

  it("keeps the owner account when the server restarts and when older tables gain columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-migrate-"))
    const dbPath = join(dir, "license.sqlite")
    const raw = new DatabaseSync(dbPath)
    raw.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        role TEXT NOT NULL,
        verified INTEGER NOT NULL,
        license_id TEXT,
        setup_hash TEXT
      );
      CREATE TABLE licenses (
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
        last_expiry_alert INTEGER
      );
    `)
    raw.prepare("INSERT INTO licenses (id, key_hash, note, plan, expires_at, status, fingerprint, devices, last_seen, user_id, last_transfer_at, device_limit, last_expiry_alert) VALUES ('lic-1', NULL, 'Owner', 'owner', NULL, 'active', NULL, '[]', NULL, 'owner-id', NULL, 8, NULL)").run()
    raw.prepare("INSERT INTO users (id, email, password_hash, role, verified, license_id, setup_hash) VALUES ('owner-id', ?, NULL, 'owner', 0, 'lic-1', NULL)").run(OWNER_EMAIL)
    raw.close()

    const first = openLicenseApi({ dbPath, ownerSetupToken: "setup-token-value", ownerPassword: "owner-password" })
    open.push(first)
    const signup = json(post(first, "/v1/account/signup", { email: "ada@example.com", password: "password1" }))
    expect(signup.pending).toBe(true)
    first.close()
    open.pop()

    const second = openLicenseApi({ dbPath, ownerSetupToken: "setup-token-value", ownerPassword: "owner-password" })
    open.push(second)
    const admin = json(post(second, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    const users = json(get(second, "/v1/admin/users", String(admin.token)))
    const rows = users.users as Array<{ id: string; email: string; role: string; status: string }>
    expect(rows.find((row) => row.email === OWNER_EMAIL)).toMatchObject({ id: "owner-id", role: "owner", status: "active" })
    expect(rows.find((row) => row.email === "ada@example.com")?.status).toBe("pending")
  })
})
