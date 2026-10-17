import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { inventoryCsv, inventoryReport } from "../src/engine/inventory"
import type { CheckoutRecord } from "../src/shared/types"

function row(overrides: Partial<CheckoutRecord>): CheckoutRecord {
  return {
    id: "c1",
    at: Date.parse("2026-10-01T12:00:00Z"),
    store: "target",
    sku: "88897904",
    product: "Elite Trainer Box",
    price: 49.99,
    outcome: "success",
    profileName: "Home",
    detail: "Order placed.",
    quantity: 1,
    ...overrides
  }
}

describe("inventory", () => {
  it("sums cost, saved value, and profit for successful purchases only", () => {
    const report = inventoryReport([
      row({ id: "a", price: 40, marketValue: 90 }),
      row({ id: "b", price: 25, marketValue: null, product: "Booster, special" }),
      row({ id: "c", outcome: "tested", price: 10, marketValue: 50 }),
      row({ id: "d", outcome: "failure", price: 10 })
    ])
    expect(report.purchases).toBe(2)
    expect(report.cost).toBe(65)
    expect(report.value).toBe(90)
    expect(report.profit).toBe(50)
    expect(report.unvalued).toBe(1)
    const csv = inventoryCsv([row({ id: "b", price: 25, product: "Booster, special" })])
    expect(csv.split("\n")[0]).toBe("at,store,sku,product,quantity,cost,value,profit")
    expect(csv).toContain('"Booster, special"')
    expect(csv).not.toContain("tested")
  })

  it("saves a current value on the purchase and reloads it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-inventory-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const saved = db.recordCheckout({
      store: "target",
      sku: "88897904",
      product: "Elite Trainer Box",
      outcome: "success",
      profileName: "Home",
      detail: "Paid $49.99",
      accountId: "",
      profileId: "",
      quantity: 1
    })
    db.recordCheckout({
      store: "target",
      sku: "1",
      product: "Test",
      outcome: "tested",
      profileName: "Home",
      detail: "Test",
      accountId: "",
      profileId: "",
      quantity: 1
    })
    expect(db.setCheckoutValue(saved.id, 80).marketValue).toBe(80)
    const again = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    again.load()
    const report = inventoryReport(again.listCheckouts())
    expect(report.rows).toHaveLength(1)
    expect(report.rows[0]?.value).toBe(80)
    expect(report.profit).toBe(30.01)
    expect(() => again.setCheckoutValue("missing", 1)).toThrow(/not found/)
  })
})