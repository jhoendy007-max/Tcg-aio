import { createServer } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { listenLicenseApi, openLicenseApi, OWNER_EMAIL } from "../license-server/server"
import { createAesCipher } from "../src/engine/cipher"
import { syncAccount } from "../src/engine/account-client"
import { Database } from "../src/engine/database"
import { createLicenseIdentity, fingerprintHash, GRANT_GRACE_MS, signEnvelope, type AccessGrant } from "../src/shared/license-proof"

const fingerprintA = fingerprintHash(["machine-guid-a", "board-a"])
const fingerprintB = fingerprintHash(["machine-guid-b", "board-b"])

function desktop(dir = mkdtempSync(join(tmpdir(), "tcgaio-confirm-"))): Database {
  const database = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
  database.load()
  return database
}

function grant(fingerprint: string, privateKey: string): string {
  const body: AccessGrant = {
    v: 1,
    ok: true,
    email: "ada@example.com",
    role: "user",
    licenseId: "license-1",
    holder: "Ada",
    plan: "standard",
    expiresAt: null,
    fingerprint,
    serverTime: Date.now(),
    graceMs: GRANT_GRACE_MS
  }
  return signEnvelope(privateKey, body)
}

describe("desktop confirm after sign-in", () => {
  const previous = {
    url: process.env.TCGAIO_LICENSE_URL,
    key: process.env.TCGAIO_LICENSE_PUBLIC_KEY
  }
  afterEach(() => {
    if (previous.url === undefined) delete process.env.TCGAIO_LICENSE_URL
    else process.env.TCGAIO_LICENSE_URL = previous.url
    if (previous.key === undefined) delete process.env.TCGAIO_LICENSE_PUBLIC_KEY
    else process.env.TCGAIO_LICENSE_PUBLIC_KEY = previous.key
  })

  it("keeps the session when the server has no confirm endpoint", async () => {
    const identity = createLicenseIdentity()
    const server = createServer((req, res) => {
      if (req.url === "/v1/session/confirm") {
        res.writeHead(404, { "content-type": "text/plain" })
        res.end("missing")
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, token: "session-token", envelope: grant(fingerprintA, identity.privateKey) }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    process.env.TCGAIO_LICENSE_URL = `http://127.0.0.1:${port}`
    process.env.TCGAIO_LICENSE_PUBLIC_KEY = identity.publicKey
    try {
      const view = await syncAccount(desktop(), fingerprintA, "/v1/account/login", { email: "ada@example.com", password: "password1" })
      expect(view.email).toBe("ada@example.com")
      expect(view.pending).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    }
  })

  it("clears the session when confirm refuses the PC", async () => {
    const identity = createLicenseIdentity()
    const server = createServer((req, res) => {
      if (req.url === "/v1/session/confirm") {
        res.writeHead(403, { "content-type": "application/json" })
        res.end(JSON.stringify({ ok: false, error: "This license is already active on another PC" }))
        return
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, token: "session-token", envelope: grant(fingerprintA, identity.privateKey) }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0
    process.env.TCGAIO_LICENSE_URL = `http://127.0.0.1:${port}`
    process.env.TCGAIO_LICENSE_PUBLIC_KEY = identity.publicKey
    const db = desktop()
    try {
      await expect(syncAccount(db, fingerprintA, "/v1/account/login", { email: "ada@example.com", password: "password1" })).rejects.toThrow("This license is already active on another PC")
      expect(db.accountView().signedIn).toBe(false)
      expect(db.sessionToken()).toBe("")
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
    }
  })

  it("confirms a real sign-in so another PC cannot take the seat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-confirm-live-"))
    const dbPath = join(dir, "license.sqlite")
    const setup = openLicenseApi({ dbPath, ownerSetupToken: "setup-token-value", ownerPassword: "owner-password" })
    const admin = JSON.parse(setup.handle("POST", "/v1/admin/login", {}, JSON.stringify({ email: OWNER_EMAIL, password: "owner-password" })).body) as { token: string }
    const created = JSON.parse(setup.handle("POST", "/v1/admin/licenses", { authorization: `Bearer ${admin.token}` }, JSON.stringify({ note: "Shop" })).body) as { id: string; key: string }
    setup.handle("POST", `/v1/admin/licenses/${created.id}/access`, { authorization: `Bearer ${admin.token}` }, "{}")
    setup.handle("POST", "/v1/account/claim", {}, JSON.stringify({ email: "ada@example.com", password: "password1", key: created.key, fingerprint: fingerprintA }))
    setup.close()
    const started = await listenLicenseApi({
      dbPath,
      port: 0,
      host: "127.0.0.1",
      adminHtml: "<p>admin</p>",
      ownerSetupToken: "setup-token-value",
      ownerPassword: "owner-password"
    })
    process.env.TCGAIO_LICENSE_URL = started.url
    process.env.TCGAIO_LICENSE_PUBLIC_KEY = started.publicKey
    try {
      const view = await syncAccount(desktop(), fingerprintA, "/v1/account/login", { email: "ada@example.com", password: "password1" })
      expect(view.email).toBe("ada@example.com")
      const other = await fetch(`${started.url}/v1/account/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "ada@example.com", password: "password1", fingerprint: fingerprintB })
      })
      expect(other.status).toBe(403)
      expect(await other.json()).toMatchObject({ error: "This license is already active on another PC" })
    } finally {
      await started.close()
    }
  })
})
