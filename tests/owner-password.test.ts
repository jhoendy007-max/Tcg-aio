import { spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { OWNER_EMAIL, openLicenseApi, type LicenseApi } from "../license-server/server"
import { fingerprintHash } from "../src/shared/license-proof"

const fingerprint = fingerprintHash(["machine-guid-owner", "board-owner"])

function post(server: LicenseApi, path: string, body: unknown, token = "") {
  return server.handle("POST", path, token ? { authorization: `Bearer ${token}` } : {}, JSON.stringify(body))
}

function get(server: LicenseApi, path: string, token = "") {
  return server.handle("GET", path, token ? { authorization: `Bearer ${token}` } : {}, "")
}

function json(result: { body: string }): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>
}

function runCli(dbPath: string, args: string[], input: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "license-server/cli.ts", ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, TCGAIO_LICENSE_DB: dbPath, TCGAIO_OWNER_SETUP_TOKEN: "", TCGAIO_OWNER_PASSWORD: "" }
  })
}

describe("owner password change", () => {
  const open: LicenseApi[] = []
  afterEach(() => {
    for (const item of open) item.close()
    open.length = 0
  })

  it("replaces a forgotten password from stdin and signs out the old sessions", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tcgaio-owner-")), "license.sqlite")
    const server = openLicenseApi({ dbPath, ownerSetupToken: "setup-token-value", ownerPassword: "owner-password" })
    open.push(server)
    const admin = json(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    const desktop = json(post(server, "/v1/account/login", { email: OWNER_EMAIL, password: "owner-password", fingerprint }))
    server.close()
    open.pop()

    const short = runCli(dbPath, ["change-owner-password"], "short\n")
    expect(short.status).not.toBe(0)
    expect(short.stderr).toContain("at least 8 characters")
    expect(short.stdout).not.toContain("short")

    const argument = runCli(dbPath, ["change-owner-password", "new-owner-password"], "")
    expect(argument.status).not.toBe(0)
    expect(argument.stderr).toContain("stdin")

    const changed = runCli(dbPath, ["change-owner-password"], "new-owner-password\nignored second line\n")
    expect(changed.status).toBe(0)
    expect(changed.stdout).toContain("jhoendy007@gmail.com")
    expect(changed.stdout).not.toContain("new-owner-password")
    expect(changed.stderr).not.toContain("new-owner-password")

    const next = openLicenseApi({ dbPath })
    open.push(next)
    expect(get(next, "/v1/admin/users", String(admin.token)).status).toBe(401)
    expect(post(next, "/v1/session/heartbeat", { token: desktop.token, fingerprint }).status).toBe(401)
    expect(post(next, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }).status).toBe(401)
    const again = json(post(next, "/v1/admin/login", { email: OWNER_EMAIL, password: "new-owner-password" }))
    expect(again.ok).toBe(true)
  })

  it("refuses to replace a password that was never set", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "tcgaio-owner-")), "license.sqlite")
    const server = openLicenseApi({ dbPath, ownerSetupToken: "setup-token-value" })
    open.push(server)
    server.close()
    open.pop()
    const refused = runCli(dbPath, ["change-owner-password"], "long-enough-password\n")
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain("set-password")
  })

  it("lets the signed-in owner change the password and keeps the session when the current password is wrong", () => {
    const server = openLicenseApi({ dbPath: join(mkdtempSync(join(tmpdir(), "tcgaio-owner-")), "license.sqlite"), ownerSetupToken: "setup-token-value", ownerPassword: "owner-password" })
    open.push(server)
    expect(post(server, "/v1/admin/password", { currentPassword: "owner-password", password: "newer-owner-password" }).status).toBe(401)
    const admin = json(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    const desktop = json(post(server, "/v1/account/login", { email: OWNER_EMAIL, password: "owner-password", fingerprint }))
    const token = String(admin.token)
    const wrong = post(server, "/v1/admin/password", { currentPassword: "nope-password", password: "newer-owner-password" }, token)
    expect(wrong.status).toBe(400)
    expect(json(wrong).error).toBe("That current password was not accepted.")
    expect(get(server, "/v1/admin/users", token).status).toBe(200)
    const same = post(server, "/v1/admin/password", { currentPassword: "owner-password", password: "owner-password" }, token)
    expect(same.status).toBe(400)
    const updated = json(post(server, "/v1/admin/password", { currentPassword: "owner-password", password: "newer-owner-password" }, token))
    expect(updated.ok).toBe(true)
    expect(get(server, "/v1/admin/users", token).status).toBe(401)
    expect(post(server, "/v1/session/heartbeat", { token: desktop.token, fingerprint }).status).toBe(401)
    const signed = json(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "newer-owner-password" }))
    expect(signed.ok).toBe(true)
  })
})
