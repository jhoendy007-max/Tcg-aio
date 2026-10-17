import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { crc32 } from "node:zlib"

const FILES = ["manifest.json", "background.js", "popup.html", "popup.js", "popup.css", "policy.mjs", "wire.mjs"]

export function extensionZip(dir = join(dirname(fileURLToPath(import.meta.url)), "..", "extension")) {
  const parts = []
  const central = []
  let offset = 0
  for (const name of FILES) {
    const data = readFileSync(join(dir, name))
    const nameBytes = Buffer.from(name)
    const sum = crc32(data) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(sum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    parts.push(local, nameBytes, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0, 8)
    entry.writeUInt16LE(0, 10)
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0, 14)
    entry.writeUInt32LE(sum, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt16LE(0, 30)
    entry.writeUInt16LE(0, 32)
    entry.writeUInt16LE(0, 34)
    entry.writeUInt16LE(0, 36)
    entry.writeUInt32LE(0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(FILES.length, 8)
  end.writeUInt16LE(FILES.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...parts, directory, end])
}

function protoBytes(field, bytes) {
  const chunks = []
  let tag = (field << 3) | 2
  const tagBytes = []
  while (tag > 127) {
    tagBytes.push((tag & 0x7f) | 0x80)
    tag = Math.floor(tag / 128)
  }
  tagBytes.push(tag)
  let length = bytes.length
  const lenBytes = []
  while (length > 127) {
    lenBytes.push((length & 0x7f) | 0x80)
    length = Math.floor(length / 128)
  }
  lenBytes.push(length)
  chunks.push(Buffer.from(tagBytes), Buffer.from(lenBytes), bytes)
  return Buffer.concat(chunks)
}

/** CRX3 container around the same zip. The signing key is not written. */
export function extensionCrx(zip) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const der = publicKey.export({ type: "spki", format: "der" })
  const crxId = createHash("sha256").update(der).digest().subarray(0, 16)
  const signed = protoBytes(2, crxId)
  const signedMessage = Buffer.concat([Buffer.from("CRX3 SignedData\0"), signed, zip])
  const signature = sign("sha256", signedMessage, privateKey)
  const proof = Buffer.concat([protoBytes(1, der), protoBytes(2, signature)])
  const header = Buffer.concat([protoBytes(2, proof), protoBytes(10000, signed)])
  const prefix = Buffer.alloc(12)
  prefix.write("Cr24", 0, "ascii")
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return Buffer.concat([prefix, header, zip])
}

export function zipNames(zip) {
  const names = []
  let offset = 0
  while (offset + 30 < zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const size = zip.readUInt32LE(offset + 18)
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString("utf8")
    names.push(name)
    offset += 30 + nameLength + extraLength + size
  }
  return names
}

function versionFrom(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
  return manifest.version
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..")
  const extensionDir = join(root, "extension")
  const version = versionFrom(extensionDir)
  const outDir = join(root, "release")
  mkdirSync(outDir, { recursive: true })
  const zip = extensionZip(extensionDir)
  const zipPath = join(outDir, `TCGAIO-Session-Sync-${version}.zip`)
  const crxPath = join(outDir, `TCGAIO-Session-Sync-${version}.crx`)
  writeFileSync(zipPath, zip)
  writeFileSync(crxPath, extensionCrx(zip))
  console.log(zipPath)
  console.log(crxPath)
}
