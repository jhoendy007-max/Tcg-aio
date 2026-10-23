import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ADMIN_REFRESH_COOKIE, OWNER_EMAIL, changeOwnerPassword, openLicenseApi, type LicenseApi } from "../license-server/server"
import { DatabaseSync } from "node:sqlite"

const device = "device-aaaaaaaaaaaaaaaa"
const open: LicenseApi[] = []
afterEach(() => { while (open.length) open.pop()?.close() })

function start(clock = { t: 1_800_000_000_000 }) {
  const dbPath = join(mkdtempSync(join(tmpdir(), "tcgaio-refresh-")), "license.sqlite")
  const server = openLicenseApi({ dbPath, ownerSetupToken: "setup-token-value", ownerPassword: "owner-password", now: () => clock.t })
  open.push(server)
  return { server, clock, dbPath }
}
const post = (s: LicenseApi, path: string, body: unknown, headers: Record<string, string> = {}) => s.handle("POST", path, headers, JSON.stringify(body), "1.2.3.4")
const get = (s: LicenseApi, path: string, token: string) => s.handle("GET", path, { authorization: `Bearer ${token}` }, "")
const body = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>

describe("admin stay signed in", () => {
  it("keeps the 0.2.35 login shape for clients without a device id", () => {
    const { server } = start()
    const r = body(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password" }))
    expect(r.ok).toBe(true)
    expect(typeof r.token).toBe("string")
    expect(r.refreshToken).toBeUndefined()
    expect(get(server, "/v1/admin/overview", r.token).status).toBe(200)
  })

  it("says wrong email or password and never logs it", () => {
    const { server } = start()
    const r = post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "nope-nope" })
    expect(r.status).toBe(401)
    expect(body(r).error).toBe("Wrong email or password.")
  })

  it("rotates refresh tokens, survives access expiry, detects reuse and binds to the device", () => {
    const { server, clock } = start()
    const login = body(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password", deviceId: device }))
    expect(login.refreshToken).toBeTruthy()
    clock.t += 2 * 60 * 60 * 1000
    expect(get(server, "/v1/admin/overview", login.token).status).toBe(401)
    expect(post(server, "/v1/admin/refresh", { refreshToken: login.refreshToken, deviceId: "other-device-bbbbbbbbbb" }).status).toBe(401)
    // device mismatch revoked the family; sign in again
    const again = body(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password", deviceId: device }))
    const next = body(post(server, "/v1/admin/refresh", { refreshToken: again.refreshToken, deviceId: device }))
    expect(next.ok).toBe(true)
    expect(next.refreshToken).not.toBe(again.refreshToken)
    expect(get(server, "/v1/admin/overview", next.token).status).toBe(200)
    clock.t += 5 * 60 * 1000
    expect(post(server, "/v1/admin/refresh", { refreshToken: again.refreshToken, deviceId: device }).status).toBe(401)
    expect(post(server, "/v1/admin/refresh", { refreshToken: next.refreshToken, deviceId: device }).status).toBe(401)
    expect(get(server, "/v1/admin/overview", next.token).status).toBe(401)
  })

  it("honors a just-rotated token inside the grace window", () => {
    const { server, clock } = start()
    const login = body(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password", deviceId: device }))
    body(post(server, "/v1/admin/refresh", { refreshToken: login.refreshToken, deviceId: device }))
    clock.t += 10_000
    const retry = body(post(server, "/v1/admin/refresh", { refreshToken: login.refreshToken, deviceId: device }))
    expect(retry.ok).toBe(true)
    expect(body(post(server, "/v1/admin/refresh", { refreshToken: retry.refreshToken, deviceId: device })).ok).toBe(true)
  })

  it("stays signed in for months with use, and sign out revokes server side", () => {
    const { server, clock } = start()
    let cur = body(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password", deviceId: device }))
    for (let i = 0; i < 20; i++) {
      clock.t += 30 * 24 * 60 * 60 * 1000
      cur = body(post(server, "/v1/admin/refresh", { refreshToken: cur.refreshToken, deviceId: device }))
      expect(cur.ok).toBe(true)
    }
    expect(post(server, "/v1/admin/logout", { refreshToken: cur.refreshToken }, { authorization: `Bearer ${cur.token}` }).status).toBe(200)
    expect(get(server, "/v1/admin/overview", cur.token).status).toBe(401)
    expect(post(server, "/v1/admin/refresh", { refreshToken: cur.refreshToken, deviceId: device }).status).toBe(401)
  })

  it("uses an httpOnly cookie for the website", () => {
    const { server } = start()
    const r = post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password", deviceId: device, web: true }, { host: "license.example.com" })
    expect(body(r).refreshToken).toBeUndefined()
    expect(r.setCookie).toMatch(/HttpOnly/)
    expect(r.setCookie).toMatch(/Secure/)
    expect(r.setCookie).toMatch(/SameSite=Strict/)
    const value = /zzz_admin_rt=([^;]+)/.exec(r.setCookie ?? "")![1]
    const next = post(server, "/v1/admin/refresh", { deviceId: device }, { cookie: `${ADMIN_REFRESH_COOKIE}=${value}`, host: "license.example.com" })
    expect(next.status).toBe(200)
    expect(next.setCookie).toMatch(/zzz_admin_rt=/)
  })

  it("password change revokes refresh tokens and the public update check works signed out", () => {
    const { server, dbPath } = start()
    const login = body(post(server, "/v1/admin/login", { email: OWNER_EMAIL, password: "owner-password", deviceId: device }))
    const db = new DatabaseSync(dbPath)
    changeOwnerPassword(db, "brand-new-password")
    db.close()
    expect(post(server, "/v1/admin/refresh", { refreshToken: login.refreshToken, deviceId: device }).status).toBe(401)
    const latest = server.handle("GET", "/v1/admin/app/latest", {}, "")
    expect(latest.status).toBe(200)
    expect(body(latest).available).toBe(false)
    expect(server.handle("GET", "/v1/admin/app/download", {}, "").status).not.toBe(200)
  })
})
