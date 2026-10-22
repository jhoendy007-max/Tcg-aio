import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { deflateRawSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { createLicenseIdentity } from "../license-server/proof"

const script = "scripts/confirm-baked-license-key.mjs"
const releaseKey = "MCowBQYDK2VwAyEAp4p3KUqyfP0sAx4lyKSB1BOZSZpnGAgFvIAStN5LlLE="
const typoKey = releaseKey.replace("StN5LlLE=", "StN5L1LE=")

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_TYPE: "", TCGAIO_REQUIRE_LICENSE: "", TCGAIO_LICENSE_PUBLIC_KEY: "", EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY: "", ...env }
  })
}

function zipWith(name: string, content: Buffer): Buffer {
  const payload = deflateRawSync(content)
  const nameBuf = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(payload.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(payload.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + nameBuf.length, 12)
  eocd.writeUInt32LE(30 + nameBuf.length + payload.length, 16)
  return Buffer.concat([local, nameBuf, payload, central, nameBuf, eocd])
}

describe("baked release public key", () => {
  it("refuses to publish when the secret or the built files differ", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-baked-"))
    const asar = join(dir, "app.asar")
    const phone = join(dir, "TCGAIO-Phone-0.2.28.apk")
    const admin = join(dir, "TCGAIO-Admin-0.2.28.apk")
    const bundle = Buffer.from(`keep ${releaseKey} end`)
    writeFileSync(asar, bundle)
    writeFileSync(phone, zipWith("assets/index.android.bundle", bundle))
    writeFileSync(admin, zipWith("assets/index.android.bundle", Buffer.from(`keep ${typoKey} end`)))
    const mismatch = run([asar, phone, admin])
    expect(mismatch.status).toBe(1)
    expect(mismatch.stderr).toMatch(/TCGAIO-Admin-0\.2\.28\.apk/)
    expect(mismatch.stderr).toMatch(/L1LE=/)
    expect(mismatch.stdout).not.toMatch(/Confirmed baked/)

    writeFileSync(admin, zipWith("assets/index.android.bundle", bundle))
    const matched = run([asar, phone, admin], { TCGAIO_LICENSE_PUBLIC_KEY: releaseKey, GITHUB_REF_TYPE: "tag" })
    expect(matched.status).toBe(0)
    expect(matched.stdout).toContain(releaseKey)
    expect(matched.stdout).toMatch(/app\.asar/)
    expect(matched.stdout).toMatch(/TCGAIO-Phone-0\.2\.28\.apk/)
    expect(matched.stdout).toMatch(/TCGAIO-Admin-0\.2\.28\.apk/)

    const { publicKey } = createLicenseIdentity()
    const wrongSecret = run(["--secret-only"], { TCGAIO_LICENSE_PUBLIC_KEY: publicKey, TCGAIO_REQUIRE_LICENSE: "1" })
    expect(wrongSecret.status).toBe(1)
    expect(wrongSecret.stderr).toMatch(/does not match the release key/)
    expect(wrongSecret.stderr).not.toContain(publicKey)
    const secret = run(["--secret-only"], { TCGAIO_LICENSE_PUBLIC_KEY: releaseKey, TCGAIO_REQUIRE_LICENSE: "1" })
    expect(secret.status).toBe(0)
    expect(secret.stdout).toMatch(/matches the release key/)
  })
})