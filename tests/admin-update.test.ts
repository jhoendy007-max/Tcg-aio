import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { listenLicenseApi, OWNER_EMAIL } from "../license-server/server"
import {
  adminDownloadTarget,
  adminDownloadUrl,
  adminUpdateDecision,
  apkMagicOk,
  downloadFailure,
  installerResultError,
  installedVersionCode,
  plainUpdateError,
  preserveUpdatePhase
} from "../src/shared/admin-update"

const open: Array<{ close(): Promise<void> }> = []

afterEach(async () => {
  while (open.length) await open.pop()?.close()
})

describe("admin app update", () => {
  it("compares version codes and explains a failed download or a closed installer", () => {
    expect(installedVersionCode("227", 0)).toBe(227)
    expect(installedVersionCode("", 229)).toBe(229)
    expect(installedVersionCode("nope", null)).toBe(0)
    expect(adminUpdateDecision(227, { available: true, version: "0.2.29", versionCode: 229 })).toEqual({ phase: "available", version: "0.2.29", versionCode: 229 })
    expect(adminUpdateDecision(229, { available: true, version: "0.2.29", versionCode: 229 }).phase).toBe("current")
    expect(adminUpdateDecision(227, { available: false, versionCode: 229 }).phase).toBe("missing")
    expect(downloadFailure(401, "", false)).toMatch(/sign in/i)
    expect(downloadFailure(200, "", false)).toMatch(/did not return an APK/i)
    expect(downloadFailure(200, "", true)).toBeNull()
    expect(downloadFailure(404, JSON.stringify({ error: "No admin update has been uploaded." }), false)).toBe("No admin update has been uploaded.")
    expect(apkMagicOk("UEsDBAoA")).toBe(true)
    expect(apkMagicOk("eyJvayI6")).toBe(false)
    expect(installerResultError(-1)).toBeNull()
    expect(installerResultError(0)).toMatch(/installer did not open/i)
    expect(plainUpdateError(new Error(""))).toMatch(/could not be installed/i)
    expect(adminDownloadTarget("https://license.example.test", 200, "ticket-1")).toEqual({ kind: "url", url: "https://license.example.test/v1/admin/app/download?ticket=ticket-1" })
    expect(adminDownloadTarget("https://license.example.test/", 404, undefined)).toEqual({ kind: "url", url: "https://license.example.test/v1/admin/app/download" })
    expect(adminDownloadTarget("https://license.example.test", 401, undefined).kind).toBe("auth")
    expect(preserveUpdatePhase("downloading")).toBe(true)
    expect(preserveUpdatePhase("installing")).toBe(true)
    expect(preserveUpdatePhase("error")).toBe(true)
    expect(preserveUpdatePhase("available")).toBe(false)
  })

  it("downloads the admin APK once with a ticket and still accepts the admin session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-admin-apk-"))
    const server = await listenLicenseApi({
      dbPath: join(dir, "license.sqlite"),
      adminHtml: "<p>ok</p>",
      ownerSetupToken: "setup-token-value",
      ownerPassword: "owner-password",
      adminUploadToken: "upload-token",
      host: "127.0.0.1"
    })
    open.push(server)
    const bytes = Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(80, 1)])
    const uploaded = await fetch(`${server.url}/v1/admin/app`, {
      method: "POST",
      headers: {
        "x-tcgaio-upload-token": "upload-token",
        "x-tcgaio-version": "0.2.30",
        "x-tcgaio-version-code": "230",
        "content-type": "application/vnd.android.package-archive"
      },
      body: bytes
    })
    expect(uploaded.status).toBe(200)
    const admin = await fetch(`${server.url}/v1/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OWNER_EMAIL, password: "owner-password" })
    })
    const session = await admin.json() as { token?: string }
    expect(admin.status).toBe(200)
    const ticketResponse = await fetch(`${server.url}/v1/admin/app/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: "{}"
    })
    const ticket = await ticketResponse.json() as { ticket?: string }
    expect(ticketResponse.status).toBe(200)
    const url = adminDownloadUrl(server.url, String(ticket.ticket))
    const first = await fetch(url)
    const file = Buffer.from(await first.arrayBuffer())
    expect(first.status).toBe(200)
    expect(file.subarray(0, 2).toString()).toBe("PK")
    expect(file.length).toBe(bytes.length)
    const again = await fetch(url)
    expect(again.status).toBe(401)
    const denied = await fetch(`${server.url}/v1/admin/app/download`)
    expect(denied.status).toBe(401)
    expect(downloadFailure(denied.status, await denied.text(), false)).toMatch(/sign in/i)
    const authed = await fetch(`${server.url}/v1/admin/app/download`, { headers: { authorization: `Bearer ${session.token}` } })
    expect(authed.status).toBe(200)
    expect(Buffer.from(await authed.arrayBuffer()).subarray(0, 2).toString()).toBe("PK")
  })
})
