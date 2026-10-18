import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { createPhoneHost } from "../src/phone/backend"
import { parseDeskMessage, projectPhoneSettings } from "../src/phone/desk"
import { asClientMessage } from "../src/phone/protocol"
import { DEFAULT_SETTINGS } from "../src/shared/types"

const address = { firstName: "Ada", lastName: "Lovelace", line1: "1 Main", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" as const }

describe("phone desk", () => {
  it("parses desk commands and keeps card numbers off the snapshot", () => {
    const parsed = asClientMessage({
      type: "profile.save",
      req: "1",
      conn: "c",
      profile: {
        name: "Home",
        email: "ada@example.com",
        phone: "2125550100",
        shipping: address,
        cardName: "Ada",
        cardNumber: "4242424242424242",
        expMonth: "12",
        expYear: "2030",
        cvv: "123",
        cardAction: "replace"
      }
    })
    expect(parsed.type).toBe("profile.save")
    if (parsed.type !== "profile.save") return
    expect(parsed.profile.cardNumber).toBe("4242424242424242")
    expect(parseDeskMessage({ type: "task.start", req: "1", conn: "c" })).toBeNull()

    const dir = mkdtempSync(join(tmpdir(), "tcgaio-phone-desk-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    db.saveProfile(parsed.profile)
    db.saveSettings({ ...db.getSettings(), discordWebhook: "https://discord.com/api/webhooks/123/secret-token", addressOrderLimits: "target:3" })
    const snap = createPhoneHost(db, () => null).snapshot()
    const text = JSON.stringify(snap)
    expect(text).not.toContain("4242424242424242")
    expect(text).not.toContain("secret-token")
    expect(text).toContain("4242")
    expect(snap.desk?.hasWebhook).toBe(true)
    expect(snap.desk?.addressOrderLimits).toBe("target:3")
    expect(snap.profiles[0]?.last4).toBe("4242")
    expect(projectPhoneSettings({ ...DEFAULT_SETTINGS, discordWebhook: "" }).hasWebhook).toBe(false)
  })

  it("creates a monitor and a checkout from quick setup without echoing a card", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-phone-quick-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const profile = db.saveProfile({
      name: "Home", email: "ada@example.com", phone: "2125550100", shipping: address, billing: address,
      cardName: "Ada", cardNumber: "4242424242424242", expMonth: "12", expYear: "2030", cvv: "123", cardAction: "replace"
    })
    const account = db.saveAccount({
      store: "target", label: "Main", username: "ada@example.com", password: "secret-pass", passwordAction: "replace", session: "", sessionAction: "clear"
    })
    const host = createPhoneHost(db, () => null)
    const made = host.quickSetup?.({
      store: "target", sku: "88897904", keywords: "", profileId: profile.id, accountId: account.id,
      proxyGroupId: null, quantity: 1, testMode: true, confirmPurchase: false
    })
    expect(made?.created).toBe(2)
    const tasks = db.listTasks()
    const monitor = tasks.find((task) => task.kind === "monitor")
    const checkout = tasks.find((task) => task.kind === "checkout")
    expect(monitor?.sku).toBe("88897904")
    expect(checkout?.startMode).toBe("monitor")
    expect(checkout?.linkedMonitorId).toBe(monitor?.id)
    const snap = JSON.stringify(host.snapshot())
    expect(snap).not.toContain("4242424242424242")
    expect(snap).not.toContain("secret-pass")
    expect(snap).toContain("a***@example.com")
  })
})
