import type { CheckoutRecord, InventoryReport, InventoryRow } from "../shared/types"

/** Purchases are successful checkouts. Cost is the recorded price. Value is the amount the user saved. */
export function inventoryReport(records: CheckoutRecord[]): InventoryReport {
  const rows = records.filter((record) => record.outcome === "success").map(toRow)
  let cost = 0
  let value = 0
  let profit = 0
  let unvalued = 0
  for (const row of rows) {
    if (row.cost !== null) cost += row.cost
    if (row.value === null || row.profit === null) unvalued += 1
    else {
      value += row.value
      profit += row.profit
    }
  }
  return {
    rows,
    purchases: rows.length,
    cost: round(cost),
    value: round(value),
    profit: round(profit),
    unvalued
  }
}

export function inventoryCsv(records: CheckoutRecord[]): string {
  const lines = ["at,store,sku,product,quantity,cost,value,profit"]
  for (const row of inventoryReport(records).rows) {
    lines.push([
      new Date(row.at).toISOString(),
      row.store,
      row.sku,
      row.product,
      row.quantity,
      row.cost ?? "",
      row.value ?? "",
      row.profit ?? ""
    ].map(csvCell).join(","))
  }
  return lines.join("\n")
}

function toRow(record: CheckoutRecord): InventoryRow {
  const cost = money(record.price)
  const value = money(record.marketValue)
  return {
    id: record.id,
    at: record.at,
    store: record.store,
    sku: record.sku,
    product: record.product || record.sku,
    quantity: record.quantity && record.quantity > 0 ? record.quantity : 1,
    cost,
    value,
    profit: cost === null || value === null ? null : round(value - cost)
  }
}

function money(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
  return round(value)
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function csvCell(value: string | number): string {
  const text = String(value)
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
  return text
}
