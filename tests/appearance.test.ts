import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { cleanImageUrl, cleanSettings } from "../src/engine/validate"
import { todayCheckoutStats } from "../src/shared/desk"
import { DEFAULT_SETTINGS, type AccountInput, type ProfileInput, type Settings } from "../src/shared/types"

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

function account(): AccountInput {
  return {
    store: "target",
    label: "Main",
    username: "ada@example.com",
    password: "correct-horse",
    passwordAction: "replace",
    session: "",
    sessionAction: "keep"
  }
}

describe("appearance", () => {
  it("keeps theme, accent, name, and sound inside the saved bounds", () => {
    const cleaned = cleanSettings({
      ...DEFAULT_SETTINGS,
      theme: "light",
      accent: "rose",
      appName: "  Shop  ",
      successSound: true,
      taskView: "compact",
      wizardDone: true,
      logoDataUrl: "data:image/png;base64,aaaa"
    })
    expect(cleaned.theme).toBe("light")
    expect(cleaned.accent).toBe("rose")
    expect(cleaned.appName).toBe("Shop")
    expect(cleaned.successSound).toBe(true)
    expect(cleaned.taskView).toBe("compact")
    expect(cleaned.wizardDone).toBe(true)
    const fallback = cleanSettings({
      ...DEFAULT_SETTINGS,
      theme: "nope" as Settings["theme"],
      accent: "nope" as Settings["accent"],
      appName: " \n ",
      taskView: "wide" as Settings["taskView"]
    })
    expect(fallback.theme).toBe("dark")
    expect(fallback.accent).toBe("gold")
    expect(fallback.appName).toBe("TCGAIO")
    expect(fallback.taskView).toBe("detailed")
    expect(fallback.successSound).toBe(false)
    expect(fallback.wizardDone).toBe(false)
  })

  it("rejects a huge logo and a product image that is not https", () => {
    expect(() => cleanSettings({ ...DEFAULT_SETTINGS, logoDataUrl: `data:image/png;base64,${"A".repeat(120_001)}` })).toThrow(/too large/)
    expect(() => cleanSettings({ ...DEFAULT_SETTINGS, logoDataUrl: "https://example.com/logo.png" })).toThrow(/PNG, JPEG, or WebP/)
    expect(cleanImageUrl("")).toBe("")
    expect(cleanImageUrl("https://cdn.example.com/box.png")).toBe("https://cdn.example.com/box.png")
    expect(() => cleanImageUrl("http://cdn.example.com/box.png")).toThrow(/https/)
  })

  it("orders tasks by the ids you pass and appends the rest", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const savedProfile = db.saveProfile(profile())
    const savedAccount = db.saveAccount(account())
    const input = { store: "target" as const, sku: "sku", quantity: 1, profileId: savedProfile.id, accountId: savedAccount.id, proxyGroupId: null, confirmPurchase: false, testMode: true }
    const first = db.saveTask({ ...input, sku: "one" })
    const second = db.saveTask({ ...input, sku: "two" })
    const third = db.saveTask({ ...input, sku: "three" })
    const ordered = db.reorderTasks([third.id, first.id])
    expect(ordered.map((task) => task.id)).toEqual([third.id, first.id, second.id])
    expect(ordered.map((task) => task.rank)).toEqual([0, 1, 2])
  })

  it("counts wins inside the local day and ignores the day before", () => {
    const now = new Date(2026, 9, 17, 15).getTime()
    const start = new Date(2026, 9, 17).getTime()
    const stats = todayCheckoutStats([
      { at: start + 1000, outcome: "success", price: 10 },
      { at: start - 1000, outcome: "success", price: 99 },
      { at: start + 2000, outcome: "failure", price: null },
      { at: start + 3000, outcome: "paused", price: null },
      { at: start + 4000, outcome: "tested", price: 5 }
    ], now)
    expect(stats.success).toBe(1)
    expect(stats.count).toBe(4)
    expect(stats.spend).toBe(10)
    expect(stats.winRate).toBeCloseTo(1 / 3)
    expect(todayCheckoutStats(undefined, now).count).toBe(0)
  })
})
