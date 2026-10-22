import { describe, expect, it } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { cleanSettings } from "../src/engine/validate"
import { recommendedModule } from "../src/shared/module-settings"
import {
  builtinRole,
  cleanStoreRoles,
  fieldMark,
  overridesWithStoreRole,
  prefillRole,
  resolveRoleDefaults
} from "../src/shared/store-defaults"
import { DEFAULT_SETTINGS } from "../src/shared/types"
import { deskText, wizardIssues, wizardSteps } from "../src/shared/desk-ui"
import { parseRoute } from "../src/shared/nav"
import { chooseWindowFrame } from "../src/shared/window-frame"

describe("store role defaults", () => {
  it("prefers a task value, then the saved store default, then the built-in module", () => {
    const builtin = builtinRole("walmart", "checkout")
    expect(builtin.monitorDelayMs).toBe(recommendedModule("walmart").monitorDelayMs)
    expect(builtin.addressOrderLimit).toBe(3)
    expect(builtin.warmOnStart).toBe(true)
    expect(builtinRole("walmart", "monitor").warmOnStart).toBe(false)

    const open = resolveRoleDefaults("walmart", "checkout", undefined)
    expect(open.monitorDelayMs).toEqual({ value: builtin.monitorDelayMs, source: "builtin" })
    expect(open.quantity).toEqual({ value: 1, source: "builtin" })

    const saved = { walmart: { checkout: { monitorDelayMs: 5500, quantity: 2 } } }
    const store = resolveRoleDefaults("walmart", "checkout", saved)
    expect(store.monitorDelayMs).toEqual({ value: 5500, source: "store" })
    expect(store.quantity).toEqual({ value: 2, source: "store" })
    expect(store.queue.source).toBe("builtin")

    const task = resolveRoleDefaults("walmart", "checkout", saved, { quantity: 4, monitorDelayMs: 1500 })
    expect(task.quantity).toEqual({ value: 4, source: "task" })
    expect(task.monitorDelayMs).toEqual({ value: 1500, source: "task" })
    expect(prefillRole("target", "monitor", undefined).testMode).toBe(false)
    expect(fieldMark(1, 1)).toBe("default")
    expect(fieldMark(2, 1)).toBe("custom")
  })

  it("leaves an existing task override in place and ignores unknown saved data", () => {
    const existing = { monitorDelayMs: 1800, queue: "pause" as const }
    expect(overridesWithStoreRole("target", "checkout", { target: { checkout: { monitorDelayMs: 9000, queue: "skip" } } }, existing)).toEqual(existing)
    expect(overridesWithStoreRole("target", "checkout", { target: { checkout: { monitorDelayMs: 9000 } } }, undefined)?.monitorDelayMs).toBe(9000)
    expect(overridesWithStoreRole("target", "monitor", {}, undefined)).toBeUndefined()
    expect(cleanStoreRoles(undefined)).toEqual({})
    expect(cleanStoreRoles({ nope: { checkout: { quantity: 3 } }, target: { checkout: { quantity: 99, queue: "wait" } } }).target?.checkout).toEqual({ quantity: 12, queue: "wait" })

    const migrated = cleanSettings({ ...DEFAULT_SETTINGS, storeRoles: undefined as never })
    expect(migrated.storeRoles).toEqual({})
    expect(migrated.monitorDelayMs).toBe(DEFAULT_SETTINGS.monitorDelayMs)

    const dir = mkdtempSync(join(tmpdir(), "tcgaio-roles-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const profile = db.saveProfile({
      name: "Home",
      email: "ada@example.com",
      phone: "2125550100",
      shipping: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
      billing: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
      cardName: "Ada",
      cardNumber: "4242424242424242",
      expMonth: "12",
      expYear: "2030",
      cvv: "123",
      cardAction: "replace"
    })
    const account = db.saveAccount({ store: "target", label: "Main", username: "ada@example.com", password: "secret", passwordAction: "replace", session: "", sessionAction: "keep" })
    const task = db.saveTask({
      store: "target",
      sku: "A-1",
      quantity: 2,
      profileId: profile.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: false,
      testMode: true,
      kind: "checkout",
      overrides: { monitorDelayMs: 1600 }
    })
    db.saveSettings({ ...db.getSettings(), storeRoles: { target: { checkout: { quantity: 9, monitorDelayMs: 8000 } } } })
    const again = db.getTask(task.id)
    expect(again.quantity).toBe(2)
    expect(again.overrides?.monitorDelayMs).toBe(1600)
    expect(db.getSettings().storeRoles.target?.checkout?.quantity).toBe(9)
  })
})

describe("desk navigation and first-run copy", () => {
  it("groups old pages into five sections and keeps both languages", () => {
    expect(parseRoute("#monitors").section).toBe("tasks")
    expect(parseRoute("#monitors").tab).toBe("monitor")
    expect(parseRoute("#profiles")).toEqual({ section: "profiles", tab: "" })
    expect(parseRoute("#people/accounts")).toEqual({ section: "accounts", tab: "" })
    expect(parseRoute("#clients").section).toBe("aco")
    expect(parseRoute("#accounts").section).toBe("accounts")
    expect(parseRoute("#logs")).toEqual({ section: "settings", tab: "logs" })
    expect(parseRoute("#settings/stores").tab).toBe("stores")
    expect(parseRoute("#nope").section).toBe("home")
    expect(wizardSteps()).toEqual(["profile", "account", "task"])
    expect(wizardIssues("profile", { email: "nope", phone: "12", card: "1", line1: "" }, "en").length).toBeGreaterThan(0)
    expect(wizardIssues("profile", { email: "nope", phone: "12", card: "1", line1: "" }, "es").join(" ")).toContain("correo")
    expect(wizardIssues("task", { sku: "A-1" }, "es")).toEqual([])
    expect(deskText("es", "navTasks")).toBe("Tareas")
    expect(deskText("en", "emptyNext")).toContain("first task")
  })

  it("fits the window to the display and keeps a saved frame on screen", () => {
    const laptop = { x: 0, y: 0, width: 1366, height: 768 }
    const first = chooseWindowFrame(laptop, null)
    expect(first.maximize).toBe(true)
    expect(first.bounds.width).toBeLessThanOrEqual(1366)
    expect(first.bounds.height).toBeLessThanOrEqual(768)
    const wide = chooseWindowFrame({ x: 10, y: 20, width: 2560, height: 1440 }, null)
    expect(wide.maximize).toBe(false)
    expect(wide.bounds.width).toBeLessThanOrEqual(1600)
    expect(wide.bounds.x).toBeGreaterThanOrEqual(10)
    const parked = chooseWindowFrame({ x: 0, y: 0, width: 1920, height: 1080 }, { x: 4000, y: 4000, width: 3000, height: 2000 })
    expect(parked.bounds.x + parked.bounds.width).toBeLessThanOrEqual(1920)
    expect(parked.bounds.y + parked.bounds.height).toBeLessThanOrEqual(1080)
  })
})
