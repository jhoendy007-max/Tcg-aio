import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { openBackup } from "../src/engine/backup"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import {
  activateRemote,
  activationRequest,
  assertLicenseAllowed,
  createLicenseIdentity,
  handleLicenseHttp,
  listenLicense,
  readLicense,
  signLicense,
  type IssuedLicense,
  type LicenseStore
} from "../src/engine/license"
import type { HttpClient } from "../src/engine/http"
import { TaskService } from "../src/engine/task-runner"
import type { StoreModule } from "../src/stores/module"

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

function memoryStore(): LicenseStore & { issued: IssuedLicense[] } {
  const identity = createLicenseIdentity()
  const rows: Array<IssuedLicense & { token: string }> = []
  return {
    issued: rows,
    publicKey: () => identity.publicKey,
    adminOk: (token) => token === "admin-token-value",
    findToken: (key) => rows.find((row) => row.token === key) ?? null,
    remember: (record, key) => {
      const found = rows.find((row) => row.id === record.id)
      if (found) Object.assign(found, record, { token: key })
      else rows.unshift({ ...record, token: key })
    },
    list: () => rows.map((row) => ({ id: row.id, holder: row.holder, seats: row.seats, expiresAt: row.expiresAt, revoked: row.revoked, machines: [...row.machines] })),
    mint: (input) => {
      const signed = signLicense(identity.privateKey, input)
      const record: IssuedLicense & { token: string } = {
        id: signed.payload.id,
        holder: signed.payload.holder,
        seats: signed.payload.seats,
        expiresAt: signed.payload.exp,
        revoked: false,
        machines: [],
        token: signed.token
      }
      rows.unshift(record)
      return { token: signed.token, record }
    },
    revoke: (id) => {
      const row = rows.find((item) => item.id === id)
      if (row) row.revoked = true
    }
  }
}

describe("licenses", () => {
  it("activates one machine per seat and refuses card fields", () => {
    const store = memoryStore()
    const minted = store.mint({ holder: "Shop", seats: 1, expiresAt: null })
    const machineA = "11111111-1111-4111-8111-111111111111"
    const machineB = "22222222-2222-4222-8222-222222222222"
    const first = handleLicenseHttp(store, "POST", "/v1/activate", {}, activationRequest(minted.token, machineA, "0.2.18"))
    expect(first.status).toBe(200)
    expect(JSON.parse(first.body).holder).toBe("Shop")
    const second = handleLicenseHttp(store, "POST", "/v1/activate", {}, activationRequest(minted.token, machineB, "0.2.18"))
    expect(second.status).toBe(400)
    expect(store.issued[0]?.machines).toEqual([machineA])
    const dirty = JSON.stringify({ key: minted.token, machineId: machineA, version: "0.2.18", cardNumber: "4242424242424242", cvv: "123" })
    const rejected = handleLicenseHttp(store, "POST", "/v1/activate", {}, dirty)
    expect(rejected.status).toBe(400)
    expect(rejected.body).not.toContain("4242424242424242")
    expect(store.issued[0]?.machines).toEqual([machineA])
    const hidden = handleLicenseHttp(store, "POST", "/v1/admin/licenses", {}, JSON.stringify({ holder: "Other", seats: 1, expiresAt: null }))
    expect(hidden.status).toBe(401)
    const tampered = `${minted.token.slice(0, -4)}abcd`
    expect(() => readLicense(tampered, store.publicKey())).toThrow(/not valid/)
    expect(() => assertLicenseAllowed({ v: 1, id: minted.record.id, holder: "Shop", seats: 1, exp: Date.now() - 5000 })).toThrow(/expired/)
  })

  it("sends only the key, machine, and version to a license server", async () => {
    const calls: string[] = []
    const http: HttpClient = {
      async request(input) {
        calls.push(input.body ?? "")
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true, licenseId: "id-1", holder: "Shop", seats: 2, expiresAt: null }) }
      }
    }
    const status = await activateRemote(http, "https://licenses.example.com", "signed-key", "11111111-1111-4111-8111-111111111111", "0.2.18")
    expect(status.holder).toBe("Shop")
    expect(Object.keys(JSON.parse(calls[0] ?? "{}")).sort()).toEqual(["key", "machineId", "version"])
    const leaking: HttpClient = {
      async request() {
        return { status: 200, headers: {}, body: JSON.stringify({ ok: true, holder: "Shop", licenseId: "id-1", seats: 1, expiresAt: null, cardNumber: "4242424242424242" }) }
      }
    }
    await expect(activateRemote(leaking, "https://licenses.example.com", "signed-key", "11111111-1111-4111-8111-111111111111", "0.2.18")).rejects.toThrow(/card/)
  })

  it("keeps the signing key out of a backup and blocks task start until activation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-license-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    db.generateLicenseIdentity()
    const minted = db.mintLicense({ holder: "Shop", seats: 2, expiresAt: null })
    const sealed = db.backupFile("correct horse battery")
    expect(sealed).not.toContain(minted.key)
    expect(JSON.stringify(openBackup(sealed, "correct horse battery"))).not.toContain(minted.key)
    expect(readFileSync(join(dir, "tcgaio.json"), "utf8")).not.toContain(minted.key)
    expect(db.licenseAllows()).toBe(true)
    db.saveSettings({ ...db.getSettings(), licenseRequired: true })
    expect(db.licenseAllows()).toBe(false)
    const profile = db.saveProfile({
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
    })
    const account = db.saveAccount({
      store: "target",
      label: "Main",
      username: "ada@example.com",
      password: "",
      passwordAction: "clear",
      session: "",
      sessionAction: "clear"
    })
    const task = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: profile.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: true,
      testMode: true
    })
    let ran = false
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run() {
        ran = true
        return { outcome: "tested", detail: "Stopped before place order." }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false)
    expect(() => service.start(task.id)).toThrow(/not activated/)
    expect(ran).toBe(false)
    db.activateLicense(minted.key)
    expect(db.licenseAllows()).toBe(true)
    expect(db.licenseView().issued[0]?.machines).toEqual([db.pcId()])
    const server = await listenLicense(0, {
      publicKey: () => db.licensePublicKey(),
      adminOk: (token) => token === "admin-token-value",
      findToken: (key) => db.findLicenseToken(key),
      remember: (record, key) => db.rememberLicense(record, key),
      list: () => db.licenseView().issued,
      mint: (input) => {
        const created = db.mintLicense(input)
        const record = db.licenseView().issued.find((row) => row.id === created.id)
        if (!record) throw new Error("missing")
        return { token: created.key, record }
      },
      revoke: (id) => db.revokeLicense(id)
    })
    try {
      const response = await fetch(`${server.url}/v1/activate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: activationRequest(minted.key, "33333333-3333-4333-8333-333333333333", "0.2.18")
      })
      expect(response.status).toBe(200)
      const body = await response.json() as { holder: string }
      expect(body.holder).toBe("Shop")
    } finally {
      await server.close()
    }
  })
})
