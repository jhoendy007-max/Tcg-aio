import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { clientAddress, listenLicenseApi } from "../license-server/server"

describe("license server bind and proxy address", () => {
  it("runs the CLI as a module", () => {
    const output = execFileSync("npx", ["tsx", "license-server/cli.ts", "keygen"], { encoding: "utf8" })
    expect(output).toContain("TCGAIO_LICENSE_PRIVATE_KEY=")
    expect(output).toContain("TCGAIO_LICENSE_PUBLIC_KEY=")
    expect(output).not.toMatch(/Top-level await/i)
  })

  it("uses the forwarded client when the proxy is local, and the socket address otherwise", () => {
    expect(clientAddress("127.0.0.1", "1.1.1.1, 203.0.113.10")).toBe("203.0.113.10")
    expect(clientAddress("::ffff:127.0.0.1", "198.51.100.4")).toBe("198.51.100.4")
    expect(clientAddress("::1", "203.0.113.10")).toBe("203.0.113.10")
    expect(clientAddress("203.0.113.8", "1.1.1.1")).toBe("203.0.113.8")
    expect(clientAddress("203.0.113.8", "198.51.100.9", true)).toBe("198.51.100.9")
    expect(clientAddress("127.0.0.1", "")).toBe("127.0.0.1")
  })

  it("binds to localhost and rate-limits each forwarded visitor separately", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-license-bind-"))
    const dbPath = join(dir, "license.sqlite")
    const started = await listenLicenseApi({
      dbPath,
      port: 0,
      host: "127.0.0.1",
      adminHtml: "<p>admin</p>",
      ownerSetupToken: "setup-token-value",
      ownerPassword: "owner-password"
    })
    expect(started.host).toBe("127.0.0.1")
    expect(started.url.startsWith("http://127.0.0.1:")).toBe(true)
    const login = (forwarded: string) => fetch(`${started.url}/v1/account/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": forwarded },
      body: JSON.stringify({ email: "ada@example.com", password: "nope", fingerprint: "a".repeat(64) })
    })
    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const response = await login("1.1.1.1, 203.0.113.10")
        expect(response.status).toBe(401)
      }
      expect((await login("9.9.9.9, 203.0.113.10")).status).toBe(429)
      expect((await login("203.0.113.11")).status).toBe(401)
    } finally {
      await started.close()
    }
    const db = new DatabaseSync(dbPath)
    try {
      const rows = db.prepare("SELECT DISTINCT ip FROM login_failures ORDER BY ip").all() as Array<{ ip: string }>
      expect(rows.map((row) => row.ip)).toEqual(["203.0.113.10", "203.0.113.11"])
    } finally {
      db.close()
    }
  })
})
