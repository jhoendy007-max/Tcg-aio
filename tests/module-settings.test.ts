import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { STORE_GAP_MS } from "../src/engine/polite"
import { asClientMessage } from "../src/phone/protocol"
import {
  MODULE_RATE_FLOOR,
  exportModulePreset,
  moduleScope,
  moduleText,
  parseModulePreset,
  recommendedModule,
  resolveModule
} from "../src/shared/module-settings"
import { DEFAULT_SETTINGS } from "../src/shared/types"

describe("store module settings", () => {
  it("uses a recommended value, then the store page, then a task", () => {
    expect(MODULE_RATE_FLOOR).toEqual(STORE_GAP_MS)
    const recommended = resolveModule("walmart", moduleScope(DEFAULT_SETTINGS))
    expect(recommended.monitorDelayMs).toEqual({ value: 4000, source: "recommended" })
    expect(recommended.rateLimitMs.value).toBe(400)
    expect(recommended.atcMode).toEqual({ value: "standard", source: "recommended" })
    expect(recommendedModule("pokemon-center").queue).toBe("wait")

    const custom = {
      ...DEFAULT_SETTINGS,
      monitorDelayMs: 9000,
      modules: { walmart: { monitorDelayMs: 5000, useGlobal: ["maxRetries" as const] } }
    }
    const store = resolveModule("walmart", moduleScope(custom))
    expect(store.monitorDelayMs).toEqual({ value: 5000, source: "module" })
    expect(store.maxRetries.source).toBe("global")
    expect(store.maxRetries.value).toBe(DEFAULT_SETTINGS.blockRetries)

    const task = resolveModule("walmart", moduleScope(custom), { monitorDelayMs: 1500 })
    expect(task.monitorDelayMs).toEqual({ value: 1500, source: "task" })
    expect(task.retryDelayMs.source).toBe("recommended")
  })

  it("keeps global test mode on and clamps the rate floor", () => {
    const forced = resolveModule("target", moduleScope({ ...DEFAULT_SETTINGS, testMode: true }), { testMode: false })
    expect(forced.testMode).toEqual({ value: true, source: "global" })
    const slow = resolveModule("target", moduleScope({
      ...DEFAULT_SETTINGS,
      modules: { target: { rateLimitMs: 1000 } }
    }))
    expect(slow.rateLimitMs).toEqual({ value: 1000, source: "module" })
    const raised = resolveModule("amazon", moduleScope(DEFAULT_SETTINGS), { rateLimitMs: 100 })
    expect(raised.rateLimitMs.value).toBe(MODULE_RATE_FLOOR.amazon)
    const taskPace = resolveModule("target", moduleScope({
      ...DEFAULT_SETTINGS,
      modules: { target: { rateLimitMs: 2000, maxRetries: 2 } }
    }), { rateLimitMs: 1500, maxRetries: 6 })
    expect(taskPace.rateLimitMs).toEqual({ value: 1500, source: "task" })
    expect(taskPace.maxRetries).toEqual({ value: 6, source: "task" })
  })

  it("exports and imports one store preset", () => {
    const settings = { ...DEFAULT_SETTINGS, modules: { target: { monitorDelayMs: 2200, queue: "pause" as const, zips: "10001" } } }
    const text = exportModulePreset("target", moduleScope(settings))
    expect(text).toContain("\"store\": \"target\"")
    expect(text).not.toContain("discord")
    const parsed = parseModulePreset(text)
    expect(parsed.store).toBe("target")
    expect(parsed.record.monitorDelayMs).toBe(2200)
    expect(parsed.record.queue).toBe("pause")
    expect(() => parseModulePreset("{")).toThrow(/JSON/i)
    expect(() => parseModulePreset(JSON.stringify({ v: 1, store: "evil", monitorDelayMs: 2000 }))).toThrow(/store/i)
    expect(() => parseModulePreset(JSON.stringify({ v: 1, store: "target", rateLimitMs: 10 }))).toThrow(/Rate limit/i)
    expect(moduleText("es", "reset")).toContain("recomendado")
    expect(moduleText("en", "save")).toContain("Save")
  })

  it("saves a store page and a task override without touching other settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-module-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    db.saveSettings({ ...db.getSettings(), monitorDelayMs: 8000 })
    const saved = db.saveModule("bestbuy", { monitorDelayMs: 2600, endpoint: "product", soldBy: "retailer" })
    expect(saved.monitorDelayMs).toBe(8000)
    expect(resolveModule("bestbuy", moduleScope(saved)).monitorDelayMs).toEqual({ value: 2600, source: "module" })
    expect(resolveModule("target", moduleScope(saved)).monitorDelayMs.source).toBe("recommended")
    const reset = db.resetModule("bestbuy")
    expect(reset.modules.bestbuy).toBeUndefined()
    const imported = db.importModule(JSON.stringify({ v: 1, store: "bandai", sessionRefreshMin: 15, queue: "skip" }))
    expect(imported.modules.bandai?.queue).toBe("skip")
    expect(resolveModule("bandai", moduleScope(imported)).sessionRefreshMin).toEqual({ value: 15, source: "module" })

    const address = { firstName: "Ada", lastName: "Lovelace", line1: "1 Main", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" as const }
    const profile = db.saveProfile({
      name: "Ada",
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
    const account = db.saveAccount({ store: "bandai", label: "Ada", username: "ada@example.com", password: "secret", passwordAction: "replace", session: "", sessionAction: "clear" })
    const task = db.saveTask({
      store: "bandai",
      sku: "1",
      quantity: 1,
      profileId: profile.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: false,
      testMode: true,
      overrides: { monitorDelayMs: 4500 }
    })
    expect(task.overrides?.monitorDelayMs).toBe(4500)
    expect(resolveModule("bandai", moduleScope(db.getSettings()), task.overrides).monitorDelayMs.source).toBe("task")
    const message = asClientMessage({ type: "module.reset", req: "1", conn: "c", store: "bandai" })
    expect(message.type).toBe("module.reset")
  })
})
