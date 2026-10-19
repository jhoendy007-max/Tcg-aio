import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { OWNER_EMAIL, openLicenseApi, type LicenseApi } from "../license-server/server"
import { accessAllowed, createLicenseIdentity, fingerprintHash, readGrant, signEnvelope } from "../src/shared/license-proof"

const fingerprintA = fingerprintHash(["machine-guid-a", "board-a"])
const fingerprintB = fingerprintHash(["machine-guid-b", "board-b"])

function api(): { api: LicenseApi; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-license-"))
  const opened = openLicenseApi({
    dbPath: join(dir, "license.sqlite"),
    ownerSetupToken: "setup-token-value",
    ownerPassword: "owner-password"
  })
  return { api: opened, dir }
}

function post(api: LicenseApi, path: string, body: unknown, token = "", ip = "127.0.0.1") {
  return api.handle("POST", path, token ? { authorization: `Bearer ${token}` } : {}, JSON.stringify(body), ip)
}

function body(result: { body: string }): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>
}

describe("hardware-bound accounts", () => {
  const open: LicenseApi[] = []
  afterEach(() => {
    for (const item of open) item.close()
    open.length = 0
  })

  it("hashes a stable fingerprint and does not keep the raw hardware id", () => {
    expect(fingerprintHash(["B", "a"])).toBe(fingerprintHash(["a", "B"]))
    expect(fingerprintHash(["a", "b"])).not.toBe(fingerprintHash(["a", "c"]))
    expect(fingerprintHash(["MACHINE-GUID-123"])).not.toContain("machine-guid-123")
  })

  it("creates a license, gives access, claims once, and refuses a second PC", () => {
    const { api: server } = api()
    open.push(server)
    const admin = body(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    const created = body(post(server, "/v1/admin/licenses", { note: "Shop" }, String(admin.token)))
    expect(created.status).toBe("draft")
    expect(String(created.key)).toMatch(/^TCGAIO-/)
    const early = post(server, "/v1/account/claim", { email: "ada@example.com", password: "password1", key: created.key, fingerprint: fingerprintA })
    expect(early.status).toBe(400)
    expect(body(early).error).toMatch(/Give access/)
    expect(post(server, `/v1/admin/licenses/${created.id}/access`, {}, String(admin.token)).status).toBe(200)
    const claimed = body(post(server, "/v1/account/claim", { email: "ada@example.com", password: "password1", key: created.key, fingerprint: fingerprintA }))
    expect(claimed.ok).toBe(true)
    const grant = readGrant(String(claimed.envelope), server.publicKey)
    expect(grant?.role).toBe("user")
    expect(grant?.email).toBe("ada@example.com")
    expect(accessAllowed(grant!, fingerprintA, grant!.serverTime + 1000)).toBe(true)
    const again = post(server, "/v1/account/claim", { email: "bea@example.com", password: "password1", key: created.key, fingerprint: fingerprintB })
    expect(again.status).toBe(400)
    const otherPc = post(server, "/v1/account/login", { email: "ada@example.com", password: "password1", fingerprint: fingerprintB })
    expect(otherPc.status).toBe(403)
    expect(body(otherPc).error).toBe("This license is already active on another PC")
    const same = body(post(server, "/v1/account/login", { email: "ada@example.com", password: "password1", fingerprint: fingerprintA }))
    expect(readGrant(String(same.envelope), server.publicKey)?.fingerprint).toBe(fingerprintA)
  })

  it("rejects a tampered grant, an expired grace window, and a local role edit", () => {
    const { api: server } = api()
    open.push(server)
    const admin = body(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    const created = body(post(server, "/v1/admin/licenses", { note: "Shop" }, String(admin.token)))
    post(server, `/v1/admin/licenses/${created.id}/access`, {}, String(admin.token))
    const claimed = body(post(server, "/v1/account/claim", { email: "ada@example.com", password: "password1", key: created.key, fingerprint: fingerprintA }))
    const envelope = String(claimed.envelope)
    const grant = readGrant(envelope, server.publicKey)!
    expect(accessAllowed(grant, fingerprintA, grant.serverTime + grant.graceMs)).toBe(true)
    expect(accessAllowed(grant, fingerprintA, grant.serverTime + grant.graceMs + 1)).toBe(false)
    expect(accessAllowed(grant, fingerprintB, grant.serverTime)).toBe(false)
    const tampered = `${envelope.slice(0, -4)}abcd`
    expect(readGrant(tampered, server.publicKey)).toBeNull()
      const forged = { ...grant, role: "owner" as const, email: OWNER_EMAIL }
      const forgedBody = Buffer.from(JSON.stringify(forged)).toString("base64url")
      expect(readGrant(`${forgedBody}.${envelope.split(".")[1]}`, server.publicKey)).toBeNull()
      const previous = process.env.TCGAIO_LICENSE_PUBLIC_KEY
      const strict = process.env.TCGAIO_LICENSE_STRICT
      process.env.TCGAIO_LICENSE_PUBLIC_KEY = server.publicKey
      process.env.TCGAIO_LICENSE_STRICT = "1"
      try {
        const dir = mkdtempSync(join(tmpdir(), "tcgaio-session-"))
        const database = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
        database.load()
        database.saveAccountSession({ token: String(claimed.token), envelope, fingerprint: fingerprintA })
        expect(database.refreshAccess(fingerprintA, grant.serverTime + 1000)).toBe(true)
        expect(database.accountView(grant.serverTime + 1000).role).toBe("user")
        const file = join(dir, "tcgaio.json")
        const raw = JSON.parse(readFileSync(file, "utf8")) as { accountSession: { role?: string; envelope: string } }
        raw.accountSession.role = "owner"
        const other = createLicenseIdentity()
        raw.accountSession.envelope = signEnvelope(other.privateKey, { ...grant, role: "owner", email: OWNER_EMAIL })
        writeFileSync(file, JSON.stringify(raw))
        const reloaded = new Database(file, createAesCipher(dir))
        reloaded.load()
        expect(reloaded.refreshAccess(fingerprintA, grant.serverTime + 1000)).toBe(false)
        expect(reloaded.accountView(grant.serverTime + 1000).role).toBe("")
      } finally {
        if (previous === undefined) delete process.env.TCGAIO_LICENSE_PUBLIC_KEY
        else process.env.TCGAIO_LICENSE_PUBLIC_KEY = previous
        if (strict === undefined) delete process.env.TCGAIO_LICENSE_STRICT
        else process.env.TCGAIO_LICENSE_STRICT = strict
      }
    })

  it("resets a binding, revokes access, and keeps the owner role on the server", () => {
    const pushes: string[] = []
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-license-"))
    const server = openLicenseApi({
      dbPath: join(dir, "license.sqlite"),
      ownerSetupToken: "setup-token-value",
      ownerPassword: "owner-password",
      push: (message) => pushes.push(message.type)
    })
    open.push(server)
    const reserved = post(server, "/v1/account/claim", { email: OWNER_EMAIL, password: "password1", key: "TCGAIO-not-a-real-key", fingerprint: fingerprintA })
    expect(body(reserved).error).toMatch(/reserved/)
    const admin = body(post(server, "/v1/admin/login", { email: "ada@example.com", password: "password1" }))
    expect(admin.ok).toBe(false)
    const owner = body(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    const created = body(post(server, "/v1/admin/licenses", {}, String(owner.token)))
    post(server, `/v1/admin/licenses/${created.id}/access`, {}, String(owner.token))
    const claimed = body(post(server, "/v1/account/claim", { email: "ada@example.com", password: "password1", key: created.key, fingerprint: fingerprintA }))
    expect(pushes).toContain("claimed")
    expect(post(server, `/v1/admin/licenses/${created.id}/reset`, {}, String(owner.token)).status).toBe(200)
    const moved = body(post(server, "/v1/account/login", { email: "ada@example.com", password: "password1", fingerprint: fingerprintB }))
    expect(readGrant(String(moved.envelope), server.publicKey)?.fingerprint).toBe(fingerprintB)
    expect(post(server, `/v1/admin/licenses/${created.id}/revoke`, {}, String(owner.token)).status).toBe(200)
    expect(pushes).toContain("revoked")
    const blocked = post(server, "/v1/account/login", { email: "ada@example.com", password: "password1", fingerprint: fingerprintB })
    expect(blocked.status).toBe(403)
    const ownerSession = body(post(server, "/v1/account/login", { email: OWNER_EMAIL, password: "owner-password", fingerprint: fingerprintA }))
    expect(readGrant(String(ownerSession.envelope), server.publicKey)?.role).toBe("owner")
    const second = body(post(server, "/v1/account/login", { email: OWNER_EMAIL, password: "owner-password", fingerprint: fingerprintB }))
    expect(readGrant(String(second.envelope), server.publicKey)?.role).toBe("owner")
    const overview = body(server.handle("GET", "/v1/admin/overview?q=ada", { authorization: `Bearer ${owner.token}` }, ""))
    expect(JSON.stringify(overview)).not.toContain(String(created.key))
    const dirty = post(server, "/v1/session/checkout", { token: claimed.token, store: "target", sku: "1", cardNumber: "4242424242424242" })
    expect(dirty.status).toBe(400)
    expect(dirty.body).not.toContain("4242424242424242")
  })

  it("clears the old license session once and leaves profiles in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-migrate-"))
    const file = join(dir, "tcgaio.json")
    const first = new Database(file, createAesCipher(dir))
    first.load()
    const profile = first.saveProfile({
      name: "Home",
      email: "ada@example.com",
      phone: "2125550100",
      shipping: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
      billing: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
      cardName: "Ada Lovelace",
      cardNumber: "4242424242424242",
      expMonth: "12",
      expYear: "2030",
      cvv: "123",
      cardAction: "replace"
    })
    const raw = JSON.parse(readFileSync(file, "utf8")) as { accountGateMigration?: string; license?: { activation?: unknown }; profiles: unknown[] }
    delete raw.accountGateMigration
    raw.license = { ...(raw.license ?? {}), activation: { tokenSecret: "old-session", licenseId: "old", holder: "Shop", expiresAt: null, seats: 1, machineId: "11111111-1111-4111-8111-111111111111", activatedAt: 1 } }
    writeFileSync(file, JSON.stringify(raw))
    const again = new Database(file, createAesCipher(dir))
    again.load()
    expect(again.listProfiles().map((item) => item.id)).toEqual([profile.id])
    expect(again.licenseView().activated).toBe(false)
    const stored = JSON.parse(readFileSync(file, "utf8")) as { accountGateMigration?: string; tasks: unknown[] }
    expect(stored.accountGateMigration).toBe("accounts-1")
    expect(stored.tasks).toEqual([])
  })
})
