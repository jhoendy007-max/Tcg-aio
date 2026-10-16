import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { SecurityInfo } from "../shared/types"

export interface Cipher extends SecurityInfo {
  encrypt(plain: string): string
  decrypt(payload: string): string
}

export function createAesCipher(userData: string): Cipher {
  mkdirSync(userData, { recursive: true })
  const keyPath = join(userData, "tcgaio.key")
  let key: Buffer
  if (existsSync(keyPath)) {
    key = readFileSync(keyPath)
    if (key.length !== 32) {
      throw new Error("The local encryption key is unreadable. Remove tcgaio.key only if you can re-enter secrets.")
    }
  } else {
    key = randomBytes(32)
    writeFileSync(keyPath, key, { mode: 0o600 })
    try {
      chmodSync(keyPath, 0o600)
    } catch {
      // Windows ignores POSIX modes. The key still lives in the user profile.
    }
  }
  return {
    method: "aes",
    description:
      "AES-256-GCM with a key stored in the app data folder. Packaged Windows builds use Windows DPAPI when it is available.",
    encrypt(plain: string) {
      const iv = randomBytes(12)
      const cipher = createCipheriv("aes-256-gcm", key, iv)
      const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
      const tag = cipher.getAuthTag()
      return `aes:${Buffer.concat([iv, tag, enc]).toString("base64")}`
    },
    decrypt(payload: string) {
      if (!payload.startsWith("aes:")) {
        throw new Error("This secret was encrypted with Windows DPAPI and can only be read on that Windows user account.")
      }
      const raw = Buffer.from(payload.slice(4), "base64")
      const iv = raw.subarray(0, 12)
      const tag = raw.subarray(12, 28)
      const enc = raw.subarray(28)
      const decipher = createDecipheriv("aes-256-gcm", key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")
    }
  }
}

export function createDpapiCipher(safeStorage: {
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}): Cipher {
  return {
    method: "dpapi",
    description:
      "Windows DPAPI through Electron safeStorage. Card numbers, CVVs, passwords, and sessions stay on this Windows user account.",
    encrypt(plain: string) {
      return `dpapi:${safeStorage.encryptString(plain).toString("base64")}`
    },
    decrypt(payload: string) {
      if (!payload.startsWith("dpapi:")) {
        throw new Error("This secret was encrypted with the local AES fallback and cannot be opened with DPAPI.")
      }
      return safeStorage.decryptString(Buffer.from(payload.slice(6), "base64"))
    }
  }
}
