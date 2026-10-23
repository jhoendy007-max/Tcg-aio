import { describe, expect, it } from "vitest"
import { stockOfLine, stockOfTask } from "../src/shared/stock"

describe("stock colours", () => {
  it("reads in and out of stock from log lines", () => {
    expect(stockOfLine("Out of stock for shipping (OUT_OF_STOCK).")).toBe("out")
    expect(stockOfLine("Item is in stock at $49.99")).toBe("in")
    expect(stockOfLine("Proxy blocked (435). Waiting 20s.")).toBe("")
  })
  it("marks a watching monitor red only after an out-of-stock reading", () => {
    expect(stockOfTask({ status: "monitoring", logs: [{ message: "Watching every 3.5s" }] })).toBe("")
    expect(stockOfTask({ status: "monitoring", logs: [{ message: "Out of stock for shipping." }] })).toBe("out")
    expect(stockOfTask({ status: "in_stock", logs: [] })).toBe("in")
    expect(stockOfTask({ status: "paused", logs: [{ message: "Out of stock" }] })).toBe("")
  })
})
