import { existsSync, readFileSync, statSync } from "node:fs"
import { inflateRawSync } from "node:zlib"
import { basename } from "node:path"
import { normalizeLicenseKey } from "./license-build-values.mjs"

/** Public Ed25519 SPKI key for the live license server. Release artifacts must contain this exact value. */
export const RELEASE_LICENSE_PUBLIC_KEY = "MCowBQYDK2VwAyEAp4p3KUqyfP0sAx4lyKSB1BOZSZpnGAgFvIAStN5LlLE="
const SPKI_PREFIX = "MCowBQYDK2VwAyEA"

function fail(message) {
  console.error(message)
  process.exit(1)
}

function zipEntry(data, suffix) {
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error("The APK is not a zip archive.")
  const count = data.readUInt16LE(eocd + 10)
  let offset = data.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > data.length || data.readUInt32LE(offset) !== 0x02014b50) throw new Error("The APK central directory could not be read.")
    const method = data.readUInt16LE(offset + 10)
    const compSize = data.readUInt32LE(offset + 20)
    const nameLen = data.readUInt16LE(offset + 28)
    const extraLen = data.readUInt16LE(offset + 30)
    const commentLen = data.readUInt16LE(offset + 32)
    const localOffset = data.readUInt32LE(offset + 42)
    const name = data.subarray(offset + 46, offset + 46 + nameLen).toString("utf8")
    offset += 46 + nameLen + extraLen + commentLen
    if (!name.endsWith(suffix)) continue
    const localNameLen = data.readUInt16LE(localOffset + 26)
    const localExtraLen = data.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLen + localExtraLen
    const compressed = data.subarray(start, start + compSize)
    if (method === 0) return Buffer.from(compressed)
    if (method === 8) return inflateRawSync(compressed)
    throw new Error(`The APK entry ${name} uses zip method ${method}.`)
  }
  throw new Error(`The APK has no ${suffix}.`)
}

function artifactBytes(file) {
  const data = readFileSync(file)
  if (file.endsWith(".apk")) return zipEntry(data, "index.android.bundle")
  return data
}

function bakedKey(data, expected) {
  const prefix = Buffer.from(SPKI_PREFIX)
  const needle = Buffer.from(expected)
  const utf16 = Buffer.from(expected, "utf16le")
  if (data.includes(needle) || data.includes(utf16)) return "match"
  let offset = 0
  let other = ""
  while (offset < data.length) {
    const at = data.indexOf(prefix, offset)
    if (at < 0) break
    const slice = data.subarray(at, at + needle.length).toString("utf8")
    if (slice === expected) return "match"
    if (!other && slice.length === expected.length) other = slice
    offset = at + prefix.length
  }
  return other
}

function checkSecret() {
  const raw = process.env.TCGAIO_LICENSE_PUBLIC_KEY || process.env.EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY || ""
  const required = process.argv.includes("--secret-only") || process.env.GITHUB_REF_TYPE === "tag" || process.env.TCGAIO_REQUIRE_LICENSE === "1"
  if (!raw.trim()) {
    if (required) fail("TCGAIO_LICENSE_PUBLIC_KEY is empty. Refusing to publish.")
    return
  }
  let normalized = ""
  try {
    normalized = normalizeLicenseKey(raw)
  } catch (err) {
    fail(err instanceof Error ? err.message : "TCGAIO_LICENSE_PUBLIC_KEY could not be read.")
  }
  if (normalized !== RELEASE_LICENSE_PUBLIC_KEY) {
    fail(`TCGAIO_LICENSE_PUBLIC_KEY does not match the release key (…${normalized.slice(-8)} vs …${RELEASE_LICENSE_PUBLIC_KEY.slice(-8)}). Refusing to publish.`)
  }
  console.log("TCGAIO_LICENSE_PUBLIC_KEY matches the release key.")
}

const secretOnly = process.argv.includes("--secret-only")
checkSecret()
if (secretOnly) process.exit(0)

const files = process.argv.slice(2).filter((arg) => arg !== "--secret-only")
if (!files.length) fail("Name the app.asar or APK files to check, or pass --secret-only.")

const confirmed = []
for (const file of files) {
  if (!existsSync(file) || !statSync(file).isFile()) fail(`Missing build file ${file}. Refusing to publish.`)
  let bytes
  try {
    bytes = artifactBytes(file)
  } catch (err) {
    fail(err instanceof Error ? err.message : `Could not read ${file}.`)
  }
  const found = bakedKey(bytes, RELEASE_LICENSE_PUBLIC_KEY)
  const label = basename(file)
  if (found === "match") {
    confirmed.push(label)
    continue
  }
  if (found) fail(`${label} baked a different public key (…${found.slice(-8)}). Refusing to publish.`)
  fail(`${label} does not contain the release public key. Refusing to publish.`)
}

console.log(`Confirmed baked license public key ${RELEASE_LICENSE_PUBLIC_KEY} in ${confirmed.join(", ")}.`)
