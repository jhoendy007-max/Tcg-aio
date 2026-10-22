import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createLicenseIdentity } from "./proof"
import { changeOwnerPassword, listenLicenseApi, setOwnerPassword } from "./server"
import { DatabaseSync } from "node:sqlite"

const command = process.argv[2] ?? "serve"
const dbPath = process.env.TCGAIO_LICENSE_DB || "license.sqlite"

if (command === "keygen") {
  const identity = createLicenseIdentity()
  console.log("Put the private key in TCGAIO_LICENSE_PRIVATE_KEY on the server. It never goes in the app.")
  console.log(`TCGAIO_LICENSE_PRIVATE_KEY=${identity.privateKey}`)
  console.log("Put the public key in TCGAIO_LICENSE_PUBLIC_KEY when you build the desktop app.")
  console.log(`TCGAIO_LICENSE_PUBLIC_KEY=${identity.publicKey}`)
} else if (command === "set-password") {
  const token = process.env.TCGAIO_OWNER_SETUP_TOKEN ?? ""
  const password = process.env.TCGAIO_OWNER_PASSWORD ?? ""
  const db = new DatabaseSync(dbPath)
  try {
    setOwnerPassword(db, token, password)
    console.log("Owner password saved for jhoendy007@gmail.com. Remove TCGAIO_OWNER_PASSWORD from the environment.")
  } finally {
    db.close()
  }
} else if (command === "change-owner-password") {
  if (process.argv.length > 3) {
    console.error("change-owner-password reads the new password from stdin. Do not pass it as an argument.")
    process.exit(1)
  }
  const password = await readStdinPassword()
  const db = new DatabaseSync(dbPath)
  try {
    changeOwnerPassword(db, password)
    console.log("Owner password changed for jhoendy007@gmail.com. Old sessions are signed out.")
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Could not change the owner password.")
    process.exitCode = 1
  } finally {
    db.close()
  }
} else if (command === "serve") {
  const adminHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "admin.html"), "utf8")
  const port = Number(process.env.PORT || 8787)
  const host = process.env.HOST?.trim() || "127.0.0.1"
  const trustProxy = process.env.TRUST_PROXY === "1" || process.env.TRUST_PROXY === "true"
  const started = await listenLicenseApi({
    dbPath,
    port,
    host,
    trustProxy,
    adminHtml,
    privateKey: process.env.TCGAIO_LICENSE_PRIVATE_KEY,
    ownerSetupToken: process.env.TCGAIO_OWNER_SETUP_TOKEN,
    ownerPassword: process.env.TCGAIO_OWNER_PASSWORD,
    adminUploadToken: process.env.TCGAIO_ADMIN_UPLOAD_TOKEN,
    adminApkDir: process.env.TCGAIO_ADMIN_APK_DIR || resolve(dirname(dbPath))
  })
  console.log(`License server listening on ${started.url}`)
  console.log(`Admin desk: ${started.url}/admin`)
  console.log(`Public key: ${started.publicKey}`)
} else {
  console.error("Use keygen, set-password, change-owner-password, or serve.")
  process.exit(1)
}

function readStdinPassword(): Promise<string> {
  if (process.stdin.isTTY) return readHiddenLine("New owner password: ")
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    process.stdin.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    process.stdin.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8")
      resolve(text.split(/\r?\n/, 1)[0] ?? "")
    })
    process.stdin.on("error", reject)
  })
}

function readHiddenLine(prompt: string): Promise<string> {
  process.stderr.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve) => {
    let value = ""
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      for (const char of text) {
        if (char === "\u0003") {
          process.stdin.setRawMode(false)
          process.stdin.off("data", onData)
          process.stderr.write("\n")
          process.exit(1)
        }
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false)
          process.stdin.off("data", onData)
          process.stderr.write("\n")
          resolve(value)
          return
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1)
          continue
        }
        value += char
      }
    }
    process.stdin.on("data", onData)
  })
}
