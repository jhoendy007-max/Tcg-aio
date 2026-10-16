import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
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

function account(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    store: "target",
    label: "Main",
    username: "ada@example.com",
    password: "correct-horse",
    passwordAction: "replace",
    session: "accessToken=token-1; visitorId=visitor-1; refreshToken=refresh-1",
    sessionAction: "replace",
    ...overrides
  }
}

describe("database", () => {
  it("encrypts card and account secrets and reloads them", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-"))
    const file = join(dir, "tcgaio.json")
    const db = new Database(file, createAesCipher(dir))
    db.load()
    const saved = db.saveProfile(profile())
    expect(saved.last4).toBe("4242")
    expect(JSON.stringify(saved)).not.toContain("4242424242424242")
    const raw = readFileSync(file, "utf8")
    expect(raw).not.toContain("4242424242424242")
    expect(raw).not.toContain("correct-horse")
    expect(raw).toContain("aes:")
    const full = db.readProfile(saved.id)
    expect(full.card.number).toBe("4242424242424242")
    expect(full.card.cvv).toBe("123")

    const login = db.saveAccount(account())
    expect(login.hasPassword).toBe(true)
    expect(login.hasSession).toBe(true)
    expect(db.readAccount(login.id).password).toBe("correct-horse")
    expect(db.readAccount(login.id).session?.accessToken).toBe("token-1")

    const reloaded = new Database(file, createAesCipher(dir))
    reloaded.load()
    expect(reloaded.readProfile(saved.id).card.cvv).toBe("123")
    const kept = reloaded.saveProfile({ ...profile({ id: saved.id, cardNumber: "", cvv: "", cardAction: "keep", expYear: "2031" }) })
    expect(kept.expYear).toBe("2031")
    expect(reloaded.readProfile(saved.id).card.number).toBe("4242424242424242")
    expect(reloaded.security().method).toBe("aes")
  })

  it("rejects a task whose account belongs to another store", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const savedProfile = db.saveProfile(profile())
    const savedAccount = db.saveAccount(account({ store: "walmart" }))
    expect(() => db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: savedProfile.id,
      accountId: savedAccount.id,
      proxyGroupId: null,
      confirmPurchase: true
    })).toThrow(/same store/)
  })
})
