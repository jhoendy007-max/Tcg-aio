import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { normalizeLicenseKey, normalizeLicenseUrl } from "./license-build-values.mjs"

const mode = process.argv[2] || "preflight"
const requireLicense = process.env.TCGAIO_REQUIRE_LICENSE === "1" || process.env.GITHUB_REF_TYPE === "tag"
const rawUrl = process.env.TCGAIO_LICENSE_URL || process.env.EXPO_PUBLIC_TCGAIO_LICENSE_URL || ""
const rawKey = process.env.TCGAIO_LICENSE_PUBLIC_KEY || process.env.EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY || ""

function fail(message) {
  console.error(message)
  process.exit(1)
}

function licenseShape() {
  const needed = requireLicense || Boolean(rawUrl.trim() || rawKey.trim())
  if (!needed) return null
  if (!rawUrl.trim() || !rawKey.trim()) {
    fail("Refusing to publish without TCGAIO_LICENSE_URL and TCGAIO_LICENSE_PUBLIC_KEY. An empty public key would lock every customer out.")
  }
  try {
    return { url: normalizeLicenseUrl(rawUrl), key: normalizeLicenseKey(rawKey) }
  } catch (err) {
    fail(err instanceof Error ? err.message : "The license build values could not be read.")
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function containsText(data, needle) {
  if (!needle) return false
  return data.includes(Buffer.from(needle)) || data.includes(Buffer.from(needle, "utf16le"))
}

if (mode === "preflight") {
  const baked = licenseShape()
  if (baked) console.log(`License release preflight ok: host ${new URL(baked.url).host}, public key ${baked.key.length} characters.`)
  process.exit(0)
}

if (mode === "export-env") {
  const dest = process.argv[3]
  if (!dest) fail("export-env needs a file path.")
  const baked = licenseShape()
  const url = baked?.url ?? ""
  const key = baked?.key ?? ""
  writeFileSync(
    dest,
    [
      `TCGAIO_LICENSE_URL=${shellQuote(url)}`,
      `TCGAIO_LICENSE_PUBLIC_KEY=${shellQuote(key)}`,
      `EXPO_PUBLIC_TCGAIO_LICENSE_URL=${shellQuote(url)}`,
      `EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY=${shellQuote(key)}`,
      ""
    ].join("\n"),
    { mode: 0o600 }
  )
  if (baked) console.log(`License values written for the phone bundle: host ${new URL(baked.url).host}, public key ${baked.key.length} characters.`)
  process.exit(0)
}

if (mode === "verify") {
  const baked = licenseShape()
  if (!baked) process.exit(0)
  const roots = process.argv.slice(3)
  if (!roots.length) fail("verify needs the built output directory.")
  const needles = {
    url: [baked.url, rawUrl.trim()].filter(Boolean),
    key: [baked.key, rawKey.trim()].filter(Boolean)
  }
  let foundUrl = false
  let foundKey = false
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) {
        walk(path)
        continue
      }
      if (!stat.isFile() || stat.size > 40_000_000) continue
      const data = readFileSync(path)
      if (!foundUrl && needles.url.some((needle) => containsText(data, needle))) foundUrl = true
      if (!foundKey && needles.key.some((needle) => containsText(data, needle))) foundKey = true
    }
  }
  for (const root of roots) walk(root)
  if (!foundUrl || !foundKey) {
    fail("The build output does not contain the license server URL and public key. Refusing to publish a build that would lock customers out.")
  }
  console.log(`License build verified: host ${new URL(baked.url).host}, public key ${baked.key.length} characters.`)
  process.exit(0)
}

fail("Use preflight or verify.")
