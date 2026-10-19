import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const mode = process.argv[2] || "preflight"
const requireLicense = process.env.TCGAIO_REQUIRE_LICENSE === "1" || process.env.GITHUB_REF_TYPE === "tag"
const url = (process.env.TCGAIO_LICENSE_URL || process.env.EXPO_PUBLIC_TCGAIO_LICENSE_URL || "").trim().replace(/\/$/, "")
const key = (process.env.TCGAIO_LICENSE_PUBLIC_KEY || process.env.EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY || "").trim()

function fail(message) {
  console.error(message)
  process.exit(1)
}

function licenseShape() {
  const needed = requireLicense || Boolean(url || key)
  if (!needed) return false
  if (!url || !key) {
    fail("Refusing to publish without TCGAIO_LICENSE_URL and TCGAIO_LICENSE_PUBLIC_KEY. An empty public key would lock every customer out.")
  }
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    fail("TCGAIO_LICENSE_URL is not a URL.")
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) fail("TCGAIO_LICENSE_URL must be an https URL.")
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    fail("TCGAIO_LICENSE_URL must be the https origin only, with no token or path.")
  }
  if (!/^[A-Za-z0-9+/]+=*$/.test(key) || key.length < 40) fail("TCGAIO_LICENSE_PUBLIC_KEY is not a usable Ed25519 public key.")
  return true
}

if (mode === "preflight") {
  if (licenseShape()) console.log(`License release preflight ok: host ${new URL(url).host}, public key ${key.length} characters.`)
  process.exit(0)
}

if (mode === "verify") {
  if (!licenseShape()) process.exit(0)
  const roots = process.argv.slice(3)
  if (!roots.length) fail("verify needs the built output directory.")
  const urlBytes = Buffer.from(url)
  const keyBytes = Buffer.from(key)
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
      if (!foundUrl && data.includes(urlBytes)) foundUrl = true
      if (!foundKey && data.includes(keyBytes)) foundKey = true
    }
  }
  for (const root of roots) walk(root)
  if (!foundUrl || !foundKey) {
    fail("The build output does not contain the license server URL and public key. Refusing to publish a build that would lock customers out.")
  }
  console.log(`License build verified: host ${new URL(url).host}, public key ${key.length} characters.`)
  process.exit(0)
}

fail("Use preflight or verify.")
