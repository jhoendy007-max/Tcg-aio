import { mkdtempSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { OWNER_EMAIL, openLicenseApi, type LicenseApi } from "../license-server/server"
import { fingerprintHash, readGrant } from "../src/shared/license-proof"
import { grantFeatures } from "../src/shared/entitlements"

const fingerprint = fingerprintHash(["machine-guid-plan", "board-plan"])

function open(dbPath = join(mkdtempSync(join(tmpdir(), "tcgaio-plans-")), "license.sqlite")): LicenseApi {
  return openLicenseApi({ dbPath, ownerSetupToken: "setup-token-value", ownerPassword: "owner-password" })
}
function call(server: LicenseApi, method: string, path: string, body: unknown, token = "") {
  return server.handle(method, path, token ? { authorization: `Bearer ${token}` } : {}, body === undefined ? "" : JSON.stringify(body))
}
function json(result: { body: string }): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>
}

function customer(server: LicenseApi, admin: string, email: string, plan?: string) {
  const created = json(call(server, "POST", "/v1/account/signup", { email, password: "password1" }))
  const users = json(call(server, "GET", "/v1/admin/users?status=pending", undefined, admin)).users as Array<{ id: string; email: string }>
  const user = users.find((row) => row.email === email)!
  const linked = json(call(server, "POST", `/v1/admin/users/${user.id}/license`, plan ? { plan } : {}, admin))
  return { created, user, linked }
}

describe("license plans and key deletion", () => {
  const servers: LicenseApi[] = []
  afterEach(() => {
    for (const item of servers) item.close()
    servers.length = 0
  })

  it("signs the plan's features into the grant and gives the owner everything", () => {
    const server = open()
    servers.push(server)
    const admin = String(json(call(server, "POST", "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" })).token)
    customer(server, admin, "std@example.com", "standard")
    customer(server, admin, "aco@example.com", "aco")
    const std = readGrant(String(json(call(server, "POST", "/v1/account/login", { email: "std@example.com", password: "password1", fingerprint })).envelope), server.publicKey)
    expect(std?.features).toEqual([])
    expect(grantFeatures(std!)).toEqual([])
    const aco = readGrant(String(json(call(server, "POST", "/v1/account/login", { email: "aco@example.com", password: "password1", fingerprint })).envelope), server.publicKey)
    expect(aco?.features).toEqual(["aco"])
    expect(grantFeatures({ role: "owner", email: OWNER_EMAIL, features: [] })).toContain("aco")
    expect(call(server, "POST", "/v1/admin/licenses", { plan: "gold" }, admin).status).toBe(400)
  })

  it("changes a plan, and refuses to change or delete the owner's key", () => {
    const server = open()
    servers.push(server)
    const admin = String(json(call(server, "POST", "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" })).token)
    const { linked } = customer(server, admin, "up@example.com", "standard")
    expect(json(call(server, "POST", `/v1/admin/licenses/${linked.id}/plan`, { plan: "aco" }, admin)).plan).toBe("aco")
    const grant = readGrant(String(json(call(server, "POST", "/v1/account/login", { email: "up@example.com", password: "password1", fingerprint })).envelope), server.publicKey)
    expect(grant?.features).toEqual(["aco"])
    const owner = (json(call(server, "GET", "/v1/admin/users?status=active", undefined, admin)).users as Array<{ role: string; licenseId: string }>).find((row) => row.role === "owner")!
    expect(call(server, "DELETE", `/v1/admin/licenses/${owner.licenseId}`, undefined, admin).status).toBe(403)
    expect(call(server, "POST", `/v1/admin/licenses/${owner.licenseId}/plan`, { plan: "standard" }, admin).status).toBe(403)
    expect(call(server, "DELETE", `/v1/admin/licenses/${linked.id}`, undefined).status).toBe(401)
  })

  it("deleting a customer's key ends access and keeps the account as pending", () => {
    const server = open()
    servers.push(server)
    const admin = String(json(call(server, "POST", "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" })).token)
    const { linked } = customer(server, admin, "gone@example.com", "aco")
    const login = json(call(server, "POST", "/v1/account/login", { email: "gone@example.com", password: "password1", fingerprint }))
    const removed = json(call(server, "DELETE", `/v1/admin/licenses/${linked.id}`, undefined, admin))
    expect(removed.deleted).toBe(true)
    const beat = call(server, "POST", "/v1/session/heartbeat", { token: login.token, fingerprint })
    expect(json(beat).envelope).toBeUndefined()
    const pending = json(call(server, "GET", "/v1/admin/users?status=pending", undefined, admin)).users as Array<{ email: string; licenseId: string }>
    expect(pending.find((row) => row.email === "gone@example.com")?.licenseId).toBe("")
    expect(call(server, "DELETE", `/v1/admin/licenses/${linked.id}`, undefined, admin).status).toBe(404)
  })

  it("moves licenses from before plans existed to ACO once", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-migrate-"))
    const dbPath = join(dir, "license.sqlite")
    const first = open(dbPath)
    const admin = String(json(call(first, "POST", "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" })).token)
    const gift = json(call(first, "POST", "/v1/admin/licenses", { note: "Old", plan: "standard" }, admin))
    first.close()
    const raw = new DatabaseSync(dbPath)
    raw.prepare("DELETE FROM meta WHERE key = 'plans_v1'").run()
    raw.close()
    const second = open(dbPath)
    servers.push(second)
    const plan = new DatabaseSync(dbPath).prepare("SELECT plan FROM licenses WHERE id = ?").get(String(gift.id)) as { plan: string }
    expect(plan.plan).toBe("aco")
    const owner = new DatabaseSync(dbPath).prepare("SELECT plan FROM licenses WHERE note = 'Owner'").get() as { plan: string }
    expect(owner.plan).toBe("owner")
  })
})
