import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { normalizeLicenseKey, normalizeLicenseUrl } from "./license-build-values.mjs"

function fail(message) {
  const error = new Error(message)
  error.licenseFailure = true
  throw error
}

function inputs() {
  return {
    mode: process.argv[2] || "preflight",
    requireLicense: process.env.TCGAIO_REQUIRE_LICENSE === "1" || process.env.GITHUB_REF_TYPE === "tag",
    rawUrl: process.env.TCGAIO_LICENSE_URL || process.env.EXPO_PUBLIC_TCGAIO_LICENSE_URL || "",
    rawKey: process.env.TCGAIO_LICENSE_PUBLIC_KEY || process.env.EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY || ""
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function containsText(data, needle) {
  if (!needle) return false
  return data.includes(Buffer.from(needle)) || data.includes(Buffer.from(needle, "utf16le"))
}

function strictRemote() {
  if (process.env.TCGAIO_LICENSE_REQUIRE_REMOTE === "1") return true
  return process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REF_TYPE === "tag"
}

async function compareLive(url, key) {
  const host = new URL(url).host
  const tagBuild = process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REF_TYPE === "tag"
  const probe = !tagBuild ? (process.env.TCGAIO_LICENSE_KEY_PROBE || "").trim() : ""
  const target = probe || `${url}/v1/public-key`
  let response
  try {
    response = await fetch(target, { signal: AbortSignal.timeout(8000), redirect: "follow" })
  } catch {
    if (strictRemote()) fail(`The license server at ${host} could not be reached to compare the public key.`)
    console.log(`License server public key was not compared (${host} could not be reached). The key is a valid Ed25519 SPKI key.`)
    return
  }
  if (response.status === 404) {
    console.log(`License server has no /v1/public-key yet (${host}). The key is a valid Ed25519 SPKI key.`)
    return
  }
  if (!response.ok) fail(`The license server public key check returned HTTP ${response.status}.`)
  let parsed
  try {
    parsed = await response.json()
  } catch {
    fail("The license server public key check did not return JSON.")
  }
  let live = ""
  try {
    live = normalizeLicenseKey(parsed?.publicKey)
  } catch {
    fail("The license server public key check did not return an Ed25519 SPKI key.")
  }
  if (live !== key) fail(`The baked public key does not match the license server (…${key.slice(-8)} vs …${live.slice(-8)}).`)
  console.log(`License server public key matches (${host}).`)
}

async function licenseShape() {
  const { requireLicense, rawUrl, rawKey } = inputs()
  const needed = requireLicense || Boolean(rawUrl.trim() || rawKey.trim())
  if (!needed) return null
  if (!rawUrl.trim() || !rawKey.trim()) {
    fail("Refusing to publish without TCGAIO_LICENSE_URL and TCGAIO_LICENSE_PUBLIC_KEY. An empty public key would lock every customer out.")
  }
  try {
    const baked = { url: normalizeLicenseUrl(rawUrl), key: normalizeLicenseKey(rawKey) }
    await compareLive(baked.url, baked.key)
    return baked
  } catch (err) {
    if (err && typeof err === "object" && err.licenseFailure) throw err
    fail(err instanceof Error ? err.message : "The license build values could not be read.")
  }
}

export async function runLicenseBuild() {
  const { mode } = inputs()
  if (mode === "preflight") {
    const baked = await licenseShape()
    if (baked) console.log(`License release preflight ok: host ${new URL(baked.url).host}, public key ${baked.key.length} characters.`)
    return
  }

  if (mode === "export-env") {
    const dest = process.argv[3]
    if (!dest) fail("export-env needs a file path.")
    const baked = await licenseShape()
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
    return
  }

  if (mode === "verify") {
    const { rawUrl, rawKey } = inputs()
    const baked = await licenseShape()
    if (!baked) return
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
    return
  }

  fail("Use preflight or verify.")
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : ""
if (entry === import.meta.url) {
  runLicenseBuild().catch((err) => {
    console.error(err instanceof Error ? err.message : "The license build values could not be read.")
    process.exit(1)
  })
}
