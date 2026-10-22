import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createLicenseIdentity } from "../license-server/proof"
import { runLicenseBuild } from "../scripts/require-license-build.mjs"

const script = "scripts/require-license-build.mjs"
const url = "https://license.example.test"
const { publicKey: key, privateKey } = createLicenseIdentity()

function run(mode: string, env: Record<string, string>, roots: string[] = []) {
  return spawnSync("node", [script, mode, ...roots], {
    encoding: "utf8",
    env: { ...process.env, TCGAIO_REQUIRE_LICENSE: "", GITHUB_ACTIONS: "", GITHUB_REF_TYPE: "", TCGAIO_LICENSE_REQUIRE_REMOTE: "", TCGAIO_LICENSE_KEY_PROBE: "", TCGAIO_LICENSE_URL: "", TCGAIO_LICENSE_PUBLIC_KEY: "", EXPO_PUBLIC_TCGAIO_LICENSE_URL: "", EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY: "", ...env }
  })
}

describe("release license guard", () => {
  it("refuses a required build with no server or key", () => {
    const result = run("preflight", { TCGAIO_REQUIRE_LICENSE: "1" })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/lock every customer out/)
    expect(result.stderr).not.toContain(key)
  })

  it("allows a non-release build to omit the license server", () => {
    expect(run("preflight", {}).status).toBe(0)
    expect(run("verify", {}, [tmpdir()]).status).toBe(0)
  })

  it("rejects a token, a path, or http", () => {
    expect(run("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: "http://license.example.test", TCGAIO_LICENSE_PUBLIC_KEY: key }).status).toBe(1)
    expect(run("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: "https://license.example.test/admin", TCGAIO_LICENSE_PUBLIC_KEY: key }).status).toBe(1)
    expect(run("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: "https://user:token@license.example.test", TCGAIO_LICENSE_PUBLIC_KEY: key }).status).toBe(1)
  })

  it("rejects a private key", () => {
    const result = run("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: url, TCGAIO_LICENSE_PUBLIC_KEY: privateKey })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/public key/)
    expect(result.stderr).not.toContain(privateKey)
  })

  it("reads the public key out of the full keygen printout", () => {
    const blob = `TCGAIO_LICENSE_PRIVATE_KEY=${privateKey}\nTCGAIO_LICENSE_PUBLIC_KEY=${key}\n`
    const result = run("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: url, TCGAIO_LICENSE_PUBLIC_KEY: blob })
    expect(result.status).toBe(0)
    expect(result.stderr).not.toContain(privateKey)
  })

  it("accepts the public key when the secret includes the keygen label", () => {
    const result = run("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: `${url}/`, TCGAIO_LICENSE_PUBLIC_KEY: `TCGAIO_LICENSE_PUBLIC_KEY=${key}` })
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/host license\.example\.test/)
    expect(result.stdout).not.toContain(key)
  })

  it("writes the canonical key for the phone bundle without printing it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-license-env-"))
    const dest = join(dir, "license.env")
    const pem = `-----BEGIN PUBLIC KEY-----\n${key.replace(/(.{16})/g, "$1\n")}\n-----END PUBLIC KEY-----`
    const result = run("export-env", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: `${url}/`, TCGAIO_LICENSE_PUBLIC_KEY: pem }, [dest])
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain(key)
    expect(result.stderr).not.toContain(key)
    const body = readFileSync(dest, "utf8")
    expect(body).toContain(`EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY='${key}'`)
    expect(body).toContain(`EXPO_PUBLIC_TCGAIO_LICENSE_URL='${url}'`)
  })

  it("requires the built files to contain the url and the public key", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-license-out-"))
    mkdirSync(join(dir, "main"))
    writeFileSync(join(dir, "main", "index.js"), `const url="";const key="";`)
    const missing = run("verify", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: url, TCGAIO_LICENSE_PUBLIC_KEY: key }, [dir])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toMatch(/does not contain the license server/)
    writeFileSync(join(dir, "main", "index.js"), `const url=${JSON.stringify(url)};const key=${JSON.stringify(key)};`)
    const found = run("verify", { GITHUB_REF_TYPE: "tag", TCGAIO_LICENSE_URL: url, TCGAIO_LICENSE_PUBLIC_KEY: key }, [dir])
    expect(found.status).toBe(0)
    expect(found.stdout).toMatch(/host license\.example\.test/)
    expect(found.stdout).not.toContain(key)
  })

  it("keeps going when the server has no public key endpoint, and fails when the live key differs", async () => {
    const other = createLicenseIdentity()
    const routes: Record<string, () => Response> = {
      "https://license.example.test/missing": () => new Response("missing", { status: 404 }),
      "https://license.example.test/match": () => Response.json({ ok: true, publicKey: key }),
      "https://license.example.test/other": () => Response.json({ ok: true, publicKey: other.publicKey }),
      "https://license.example.test/text": () => new Response("nope", { status: 200 })
    }
    const missing = await live("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: url, TCGAIO_LICENSE_PUBLIC_KEY: key, TCGAIO_LICENSE_KEY_PROBE: "https://license.example.test/missing" }, routes)
    expect(missing.status).toBe(0)
    expect(missing.stdout).toMatch(/no \/v1\/public-key yet/)
    expect(missing.stdout).not.toContain(key)
    const matched = await live("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: url, TCGAIO_LICENSE_PUBLIC_KEY: key, TCGAIO_LICENSE_KEY_PROBE: "https://license.example.test/match" }, routes)
    expect(matched.status).toBe(0)
    expect(matched.stdout).toMatch(/public key matches/)
    expect(matched.stdout).not.toContain(key)
    const mismatch = await live("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: url, TCGAIO_LICENSE_PUBLIC_KEY: key, TCGAIO_LICENSE_KEY_PROBE: "https://license.example.test/other" }, routes)
    expect(mismatch.status).toBe(1)
    expect(mismatch.stderr).toContain(key.slice(-8))
    expect(mismatch.stderr).toContain(other.publicKey.slice(-8))
    expect(mismatch.stderr).not.toContain(key)
    expect(mismatch.stderr).not.toContain(other.publicKey)
    expect(mismatch.stderr).not.toContain(privateKey)
    const text = await live("preflight", { TCGAIO_REQUIRE_LICENSE: "1", TCGAIO_LICENSE_URL: url, TCGAIO_LICENSE_PUBLIC_KEY: key, TCGAIO_LICENSE_KEY_PROBE: "https://license.example.test/text" }, routes)
    expect(text.status).toBe(1)
    expect(text.stderr).toMatch(/did not return JSON/)
  })

  it("fails a release tag when the license server cannot be reached", async () => {
    const offline = await live("preflight", {
      TCGAIO_REQUIRE_LICENSE: "1",
      TCGAIO_LICENSE_REQUIRE_REMOTE: "1",
      TCGAIO_LICENSE_URL: url,
      TCGAIO_LICENSE_PUBLIC_KEY: key,
      TCGAIO_LICENSE_KEY_PROBE: "https://license.example.test/down"
    }, { "https://license.example.test/down": () => { throw new Error("offline") } })
    expect(offline.status).toBe(1)
    expect(offline.stderr).toMatch(/could not be reached/)
    expect(offline.stderr).not.toContain(key)
    const calls: string[] = []
    const tagIgnoresProbe = await live("preflight", {
      TCGAIO_REQUIRE_LICENSE: "1",
      GITHUB_ACTIONS: "true",
      GITHUB_REF_TYPE: "tag",
      TCGAIO_LICENSE_URL: url,
      TCGAIO_LICENSE_PUBLIC_KEY: key,
      TCGAIO_LICENSE_KEY_PROBE: "https://license.example.test/missing"
    }, {}, calls)
    expect(calls).toEqual(["https://license.example.test/v1/public-key"])
    expect(tagIgnoresProbe.status).toBe(1)
    expect(tagIgnoresProbe.stderr).toMatch(/could not be reached/)
    expect(tagIgnoresProbe.stdout).not.toMatch(/no \/v1\/public-key yet/)
  })
})

async function live(mode: string, env: Record<string, string>, routes: Record<string, () => Response>, calls: string[] = []) {
  const argv = process.argv
  const previousFetch = globalThis.fetch
  const previousEnv = {
    TCGAIO_REQUIRE_LICENSE: process.env.TCGAIO_REQUIRE_LICENSE,
    GITHUB_ACTIONS: process.env.GITHUB_ACTIONS,
    GITHUB_REF_TYPE: process.env.GITHUB_REF_TYPE,
    TCGAIO_LICENSE_REQUIRE_REMOTE: process.env.TCGAIO_LICENSE_REQUIRE_REMOTE,
    TCGAIO_LICENSE_KEY_PROBE: process.env.TCGAIO_LICENSE_KEY_PROBE,
    TCGAIO_LICENSE_URL: process.env.TCGAIO_LICENSE_URL,
    TCGAIO_LICENSE_PUBLIC_KEY: process.env.TCGAIO_LICENSE_PUBLIC_KEY
  }
  const logs: string[] = []
  const originalLog = console.log
  process.argv = ["node", script, mode]
  process.env.TCGAIO_REQUIRE_LICENSE = ""
  process.env.GITHUB_ACTIONS = ""
  process.env.GITHUB_REF_TYPE = ""
  process.env.TCGAIO_LICENSE_REQUIRE_REMOTE = ""
  process.env.TCGAIO_LICENSE_KEY_PROBE = ""
  process.env.TCGAIO_LICENSE_URL = ""
  process.env.TCGAIO_LICENSE_PUBLIC_KEY = ""
  Object.assign(process.env, env)
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const target = String(input)
    calls.push(target)
    const route = routes[target]
    if (!route) throw new Error("offline")
    return route()
  }) as typeof fetch
  try {
    await runLicenseBuild()
    return { status: 0, stdout: logs.join("\n"), stderr: "" }
  } catch (err) {
    return { status: 1, stdout: logs.join("\n"), stderr: err instanceof Error ? err.message : String(err) }
  } finally {
    console.log = originalLog
    globalThis.fetch = previousFetch
    process.argv = argv
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}
