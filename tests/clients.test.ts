import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { TaskService } from "../src/engine/task-runner"
import { accountPartition } from "../src/shared/consistency"
import { clientCanStart, clientSuccessNotice, clientSummary, feeOwed, ledgerCsv, meClient, proxyGroupTakenBy, type LedgerEntry } from "../src/shared/clients"
import type { StoreModule } from "../src/stores/module"
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

function profile(overrides: Partial<ProfileInput> = {}): ProfileInput {
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
    cardAction: "replace",
    ...overrides
  }
}

function login(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    store: "target" as const,
    label: "North",
    username: "north@example.com",
    password: "",
    passwordAction: "clear" as const,
    session: "",
    sessionAction: "clear" as const,
    ...overrides
  }
}

function openDb() {
  const dir = mkdtempSync(join(tmpdir(), "tcgaio-aco-"))
  const file = join(dir, "tcgaio.json")
  const db = new Database(file, createAesCipher(dir))
  db.load()
  return { dir, file, db }
}

describe("client fees and ledger", () => {
  it("charges once per success or once per item", () => {
    expect(feeOwed({ feeBasis: "success", fee: 12.5 }, 2)).toBe(12.5)
    expect(feeOwed({ feeBasis: "item", fee: 12.5 }, 2)).toBe(25)
    expect(feeOwed({ feeBasis: "item", fee: 12.5 }, 0)).toBe(12.5)
  })

  it("builds a summary and an invoice csv without a card", () => {
    const client = { ...meClient(), name: "North" }
    const rows: LedgerEntry[] = [
      { id: "a", at: Date.parse("2026-01-02T00:00:00.000Z"), clientId: "me", clientName: "North", store: "target", sku: "888", product: "Elite, Trainer", quantity: 2, price: 49.99, orderId: "ord-1", fee: 25, paid: false, paidAt: null },
      { id: "b", at: Date.parse("2026-01-03T00:00:00.000Z"), clientId: "me", clientName: "North", store: "target", sku: "889", product: "Tin", quantity: 1, price: 19.99, orderId: "ord-2", fee: 10, paid: true, paidAt: 1 }
    ]
    const summary = clientSummary(client, rows)
    expect(summary).toMatchObject({ successes: 2, feesOwed: 35, feesPaid: 10, feesOpen: 25 })
    const csv = ledgerCsv(rows)
    expect(csv).toContain("order_id")
    expect(csv).toContain("ord-1")
    expect(csv).toContain("25.00")
    expect(csv).toContain("\"Elite, Trainer\"")
    expect(csv).not.toContain("4242424242424242")
    expect(csv.split("\n")[0]).toBe("client,store,sku,product,qty,price,order_id,timestamp,fee,paid")
  })

  it("keeps card numbers out of the success notice", () => {
    const notice = clientSuccessNotice({
      clientName: "North",
      storeName: "Target",
      sku: "88897904",
      product: "Elite Trainer Box",
      quantity: 2,
      price: 49.99,
      orderId: "ord-9",
      fee: 25
    })
    const text = JSON.stringify(notice)
    expect(text).not.toMatch(/\d{13,19}/)
    expect(text).not.toContain("cvv")
    expect(text).toContain("Fee $25.00")
    expect(text).toContain("ord-9")
    expect(notice.profileName).toBe("North")
  })

  it("treats a proxy group as belonging to one client", () => {
    const accounts = [
      { id: "a", clientId: "me", proxyGroupId: "pool" },
      { id: "b", clientId: "other", proxyGroupId: null }
    ]
    expect(proxyGroupTakenBy(accounts, "b", "other", "pool")).toBe("me")
    expect(proxyGroupTakenBy(accounts, "a", "me", "pool")).toBeNull()
    expect(proxyGroupTakenBy(accounts, "b", "other", null)).toBeNull()
    expect(clientCanStart("paused")).toBe(false)
    expect(clientCanStart("active")).toBe(true)
  })
})

describe("client storage", () => {
  it("encrypts address and card at rest and round-trips them", () => {
    const { dir, file, db } = openDb()
    const saved = db.saveProfile(profile())
    expect(saved.last4).toBe("4242")
    expect(saved.shipping.line1).toBe("1 Main St")
    expect(saved.clientId).toBe("me")
    expect(JSON.stringify(saved)).not.toContain("4242424242424242")
    const raw = readFileSync(file, "utf8")
    expect(raw).toContain("aes:")
    expect(raw).not.toContain("4242424242424242")
    expect(raw).not.toContain("1 Main St")
    expect(raw).not.toContain("ada@example.com")
    expect(raw).not.toContain("2125550100")
    const full = db.readProfile(saved.id)
    expect(full.card.number).toBe("4242424242424242")
    expect(full.card.cvv).toBe("123")
    expect(full.shipping.line1).toBe("1 Main St")
    expect(full.email).toBe("ada@example.com")

    const reloaded = new Database(file, createAesCipher(dir))
    reloaded.load()
    expect(reloaded.readProfile(saved.id).card.number).toBe("4242424242424242")
    expect(reloaded.readProfile(saved.id).shipping.line1).toBe("1 Main St")
    const exported = reloaded.exportClient("me")
    expect(exported.profiles[0]?.card.number).toBe("4242424242424242")
    expect(exported.profiles[0]?.shipping.line1).toBe("1 Main St")
    expect(exported.accounts).toEqual([])
    const after = readFileSync(file, "utf8")
    expect(after).not.toContain("4242424242424242")
    expect(after).not.toContain("1 Main St")
  })

  it("seals a legacy plaintext profile on load", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-legacy-"))
    const file = join(dir, "tcgaio.json")
    const cipher = createAesCipher(dir)
    writeFileSync(file, JSON.stringify({
      version: 1,
      profiles: [{
        id: randomUUID(),
        name: "Home",
        email: "ada@example.com",
        phone: "2125550100",
        shipping: address,
        billing: address,
        cardName: "Ada Lovelace",
        last4: "4242",
        expMonth: "12",
        expYear: "2030",
        cardSecret: cipher.encrypt(JSON.stringify({ number: "4242424242424242", cvv: "123", expMonth: "12", expYear: "2030", name: "Ada Lovelace" }))
      }]
    }))
    const db = new Database(file, createAesCipher(dir))
    db.load()
    const raw = readFileSync(file, "utf8")
    expect(raw).not.toContain("1 Main St")
    expect(raw).not.toContain("ada@example.com")
    expect(raw).not.toContain("4242424242424242")
    const saved = db.listProfiles()[0]
    expect(saved?.shipping.line1).toBe("1 Main St")
    expect(saved?.clientId).toBe("me")
    expect(db.readProfile(saved!.id).card.cvv).toBe("123")
    expect(db.listClients().some((client) => client.id === "me")).toBe(true)
  })

  it("keeps each client on their own proxy group and session partition", () => {
    const { db } = openDb()
    const north = db.saveClient({ name: "North", fee: 10, feeBasis: "success", status: "active" })
    const pool = db.saveProxyGroup({ name: "North pool", text: "10.0.0.1:8000:user:secret" })
    const first = db.saveAccount(login({ proxyGroupId: pool.id, clientId: north.id }))
    expect(() => db.saveAccount(login({
      label: "Me",
      username: "me@example.com",
      proxyGroupId: pool.id,
      clientId: "me"
    }))).toThrow(/proxy group/)
    const second = db.saveAccount(login({
      store: "walmart",
      label: "Me",
      username: "me@example.com",
      clientId: "me"
    }))
    const listed = db.listAccounts()
    const northAccount = listed.find((item) => item.id === first.id)
    const meAccount = listed.find((item) => item.id === second.id)
    expect(northAccount?.profilePartition).toBe(accountPartition(first.id))
    expect(meAccount?.profilePartition).toBe(accountPartition(second.id))
    expect(northAccount?.profilePartition).not.toBe(meAccount?.profilePartition)
    expect(northAccount?.profilePartition?.startsWith("persist:account-")).toBe(true)
  })

  it("refuses a checkout that mixes two clients", () => {
    const { db } = openDb()
    const north = db.saveClient({ name: "North", fee: 5, feeBasis: "item" })
    const mine = db.saveProfile(profile())
    const theirs = db.saveProfile(profile({ name: "North home", email: "north@example.com", clientId: north.id }))
    const account = db.saveAccount(login({ clientId: north.id }))
    expect(() => db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: mine.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: true
    })).toThrow(/same client/)
    const task = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 2,
      profileId: theirs.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: true
    })
    expect(task.clientId).toBe(north.id)
  })

  it("records a success fee, marks it paid, and leaves tests off the ledger", async () => {
    const { file, db } = openDb()
    const north = db.saveClient({ name: "North", fee: 12.5, feeBasis: "item", contact: "north@example.com" })
    const savedProfile = db.saveProfile(profile({ email: "north@example.com", clientId: north.id }))
    const account = db.saveAccount(login({
      session: "accessToken=token-1; visitorId=visitor-1",
      sessionAction: "replace",
      clientId: north.id
    }))
    const task = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 2,
      profileId: savedProfile.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: true
    })
    const success: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run() {
        return { outcome: "success", orderId: "ord-7", detail: "Order ord-7" }
      }
    }
    const service = new TaskService(db, new Map([["target", success]]), () => undefined, async () => false)
    service.start(task.id)
    await service.wait(task.id)
    const rows = db.listLedger(north.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ clientId: north.id, clientName: "North", store: "target", sku: "88897904", quantity: 2, orderId: "ord-7", fee: 25, paid: false })
    expect(db.listCheckouts()[0]?.clientId).toBe(north.id)
    const csv = db.ledgerExport(north.id)
    expect(csv).toContain("ord-7")
    expect(csv).toContain("25.00")
    expect(csv).not.toContain("4242424242424242")
    expect(readFileSync(file, "utf8")).not.toContain("4242424242424242")
    const summary = db.summarizeClients().find((row) => row.clientId === north.id)
    expect(summary).toMatchObject({ successes: 1, feesOwed: 25, feesPaid: 0, feesOpen: 25 })
    db.markLedgerPaid(north.id, [rows[0]!.id], true)
    expect(db.summarizeClients().find((row) => row.clientId === north.id)?.feesOpen).toBe(0)

    const tested = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: savedProfile.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: false,
      testMode: true
    })
    const rehearsal: StoreModule = { ...success, async run() { return { outcome: "tested", detail: "Stopped before place order." } } }
    const rehearsalRun = new TaskService(db, new Map([["target", rehearsal]]), () => undefined, async () => false)
    rehearsalRun.start(tested.id)
    await rehearsalRun.wait(tested.id)
    expect(db.listLedger(north.id)).toHaveLength(1)
    expect(db.getTask(tested.id).status).toBe("tested")
  })

  it("refuses to start a paused client and deletes that client's data", () => {
    const { file, db } = openDb()
    const north = db.saveClient({ name: "North", fee: 4, status: "paused" })
    const savedProfile = db.saveProfile(profile({ email: "north@example.com", clientId: north.id }))
    const account = db.saveAccount(login({ clientId: north.id }))
    const task = db.saveTask({
      store: "target",
      sku: "1",
      quantity: 1,
      profileId: savedProfile.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: true
    })
    const service = new TaskService(db, new Map(), () => undefined, async () => false)
    expect(() => service.start(task.id)).toThrow(/paused/)
    expect(db.listLedger()).toHaveLength(0)
    db.saveClient({ id: north.id, name: "North", status: "active", fee: 4 })
    db.patchTask(task.id, { status: "monitoring" })
    expect(() => db.deleteClient(north.id)).toThrow(/Stop this client's tasks/)
    db.patchTask(task.id, { status: "idle" })
    const removed = db.deleteClient(north.id)
    expect(removed.accountIds).toEqual([account.id])
    expect(db.listProfiles().some((item) => item.id === savedProfile.id)).toBe(false)
    expect(db.listAccounts().some((item) => item.id === account.id)).toBe(false)
    expect(db.listTasks().some((item) => item.id === task.id)).toBe(false)
    expect(() => db.deleteClient("me")).toThrow(/Me client/)
    expect(db.listClients().some((client) => client.id === "me")).toBe(true)
    expect(readFileSync(file, "utf8")).not.toContain("1 Main St")
    expect(() => db.saveClient({ name: "Bad", webhook: "https://example.com/hook" })).toThrow(/discord.com/)
  })
})
