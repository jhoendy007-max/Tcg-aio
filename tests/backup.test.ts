import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { assertBackupUrl, getBackup, openBackup, putBackup } from "../src/engine/backup"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import type { HttpClient } from "../src/engine/http"
import type { AccountInput, ProfileInput } from "../src/shared/types"

const address = {
  firstName: "Ada",
  lastName: "Lovelace",
  line1: "1 Main St",
  line2: "",
  city: "New York",
  state: "NY",
  zip: "10001",
  country: "US" as const
}

function profile(): ProfileInput {
  return {
    name: "Home",
    email: "ada@example.com",
    phone: "2125550100",
    shipping: address,
    billing: address,
    cardName: "Ada Lovelace",
    cardNumber: "4242424242424242",
    expMonth: "12",
    expYear: "2030",
    cvv: "123",
    cardAction: "replace"
  }
}

function account(proxyGroupId: string): AccountInput {
  return {
    store: "target",
    label: "Main",
    username: "ada@example.com",
    password: "correct-horse",
    passwordAction: "replace",
    session: "accessToken=token-1; visitorId=visitor-1; refreshToken=refresh-1",
    sessionAction: "replace",
    proxyGroupId
  }
}

function openDb(): { db: Database; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-backup-"))
  const file = join(dir, "tcgaio.json")
  const db = new Database(file, createAesCipher(dir))
  db.load()
  return { db, file, dir }
}

describe("encrypted backup", () => {
  it("round-trips secrets inside ciphertext and keeps the destination pc identity", () => {
    const source = openDb()
    const savedProfile = source.db.saveProfile(profile())
    const group = source.db.saveProxyGroup({ name: "Home", text: "proxy.example:8080:user:secret-proxy" })
    const savedAccount = source.db.saveAccount(account(group.id))
    const task = source.db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: savedProfile.id,
      accountId: savedAccount.id,
      proxyGroupId: group.id,
      confirmPurchase: false,
      testMode: true
    })
    source.db.patchTask(task.id, { status: "monitoring", detail: "Watching" })
    source.db.saveSchedule({
      name: "Morning",
      enabled: true,
      startAt: Date.now() + 3_600_000,
      stopAt: null,
      warmupMin: 0,
      taskIds: [task.id],
      group: ""
    })
    source.db.saveTemplate({
      name: "ETB",
      enabled: true,
      store: "target",
      sku: "88897904",
      keywords: "",
      profileIds: [savedProfile.id],
      accountIds: [savedAccount.id],
      proxyGroupId: null,
      quantity: 1,
      maxPrice: null,
      testMode: true,
      confirmPurchase: false
    })
    source.db.saveDevice({ id: randomUUID(), name: "Source phone", token: "source-device-token" })
    source.db.setBackupToken("replace", "source-upload-token")
    source.db.saveSettings({ ...source.db.getSettings(), backupUrl: "https://example.com/tcgaio/backup" })

    const sealed = source.db.backupFile("correct horse battery")
    expect(sealed).not.toContain("4242424242424242")
    expect(sealed).not.toContain("correct-horse")
    expect(sealed).not.toContain("secret-proxy")
    expect(sealed).not.toContain("source-device-token")
    expect(sealed).not.toContain("source-upload-token")
    expect(sealed).not.toContain("tokenSecret")
    expect(sealed).toContain("\"ct\"")
    const paused = openBackup(sealed, "correct horse battery")
    expect(paused.tasks[0]?.status).toBe("paused")
    expect(paused.tasks[0]?.detail).toBe("Paused for backup.")

    const dest = openDb()
    const destPc = dest.db.pcId()
    dest.db.saveDevice({ id: randomUUID(), name: "Dest phone", token: "dest-device-token" })
    dest.db.setBackupToken("replace", "dest-upload-token")
    dest.db.restoreFile(sealed, "correct horse battery")

    expect(dest.db.pcId()).toBe(destPc)
    expect(dest.db.deviceTokens().map((device) => device.token)).toEqual(["dest-device-token"])
    expect(dest.db.backupToken()).toBe("dest-upload-token")
    expect(dest.db.hasBackupToken()).toBe(true)
    expect(dest.db.getSettings().backupUrl).toBe("https://example.com/tcgaio/backup")
    expect(dest.db.readProfile(savedProfile.id).card.number).toBe("4242424242424242")
    expect(dest.db.readProfile(savedProfile.id).card.cvv).toBe("123")
    expect(dest.db.readAccount(savedAccount.id).password).toBe("correct-horse")
    expect(dest.db.readAccount(savedAccount.id).session?.accessToken).toBe("token-1")
    expect(dest.db.listProxyGroups()[0]?.proxies[0]?.password).toBe("secret-proxy")
    expect(dest.db.listTasks()).toHaveLength(1)
    expect(dest.db.listTasks()[0]?.status).toBe("idle")
    expect(dest.db.listSchedules()).toHaveLength(1)
    expect(dest.db.listTemplates()).toHaveLength(1)
    const raw = readFileSync(dest.file, "utf8")
    expect(raw).not.toContain("4242424242424242")
    expect(raw).not.toContain("correct-horse")
    expect(raw).not.toContain("dest-device-token")
    expect(raw).not.toContain("dest-upload-token")

    expect(() => dest.db.restoreFile(sealed, "wrong passphrase")).toThrow(/passphrase/)
    expect(dest.db.readProfile(savedProfile.id).card.cvv).toBe("123")
  })

  it("uploads and downloads only the sealed blob", async () => {
    const source = openDb()
    source.db.saveProfile(profile())
    const sealed = source.db.backupFile("correct horse battery")
    const calls: { method: string; url: string; body?: string; authorization?: string }[] = []
    const http: HttpClient = {
      async request(input) {
        calls.push({ method: input.method, url: input.url, body: input.body, authorization: input.headers?.authorization })
        if (input.method === "GET") return { status: 200, headers: {}, body: sealed }
        return { status: 201, headers: {}, body: "" }
      }
    }
    await putBackup(http, "https://example.com/tcgaio/backup", "upload-token-value", sealed)
    expect(calls[0]?.method).toBe("PUT")
    expect(calls[0]?.authorization).toBe("Bearer upload-token-value")
    expect(calls[0]?.body).not.toContain("4242424242424242")
    const downloaded = await getBackup(http, "https://example.com/tcgaio/backup", "upload-token-value")
    expect(downloaded).toBe(sealed)
    expect(() => assertBackupUrl("https://user:secret@example.com/backup")).toThrow(/token/)
    expect(() => assertBackupUrl("http://example.com/backup")).toThrow(/https/)
    const redirecting: HttpClient = {
      async request() {
        return { status: 302, headers: { location: "https://evil.example/steal" }, body: "" }
      }
    }
    await expect(putBackup(redirecting, "https://example.com/tcgaio/backup", "", sealed)).rejects.toThrow(/redirected/)
  })
})
