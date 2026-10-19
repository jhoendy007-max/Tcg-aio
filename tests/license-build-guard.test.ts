import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const script = "scripts/require-license-build.mjs"
const url = "https://license.example.test"
const key = "MCowBQYDK2VwAyEAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa="

function run(mode: string, env: Record<string, string>, roots: string[] = []) {
  return spawnSync("node", [script, mode, ...roots], {
    encoding: "utf8",
    env: { ...process.env, TCGAIO_REQUIRE_LICENSE: "", GITHUB_REF_TYPE: "", TCGAIO_LICENSE_URL: "", TCGAIO_LICENSE_PUBLIC_KEY: "", EXPO_PUBLIC_TCGAIO_LICENSE_URL: "", EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY: "", ...env }
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
})
