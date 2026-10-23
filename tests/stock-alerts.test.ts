import { describe, expect, it } from "vitest"
import { buildDiscordBody } from "../src/engine/discord"
import { migrateTaskWebhook, noticeAllowed, StockAlerts, stockKey } from "../src/engine/stock-alerts"
import { DEFAULT_SETTINGS } from "../src/shared/types"

describe("in-stock Discord alerts", () => {
  it("builds a green embed with product, image, store, price, SKU, link, time and Zzz branding", () => {
    const at = Date.UTC(2026, 9, 22, 23, 0, 0)
    const body = buildDiscordBody({
      kind: "instock",
      store: "target",
      storeName: "Target",
      sku: "93954435",
      title: "Prismatic Evolutions ETB",
      profileName: "Monitor",
      detail: "The monitor saw this item in stock.",
      price: 59.99,
      url: "https://www.target.com/p/-/A-93954435",
      imageUrl: "https://target.scene7.com/is/image/Target/GUEST_1",
      at
    })
    const embed = body.embeds[0] as Record<string, any>
    expect(embed.color).toBe(0x39ff88)
    expect(embed.title).toContain("In stock")
    expect(embed.title).toContain("Prismatic Evolutions ETB")
    expect(embed.url).toBe("https://www.target.com/p/-/A-93954435")
    expect(embed.thumbnail.url).toBe("https://target.scene7.com/is/image/Target/GUEST_1")
    expect(embed.timestamp).toBe(new Date(at).toISOString())
    const fields = Object.fromEntries((embed.fields as Array<{ name: string; value: string }>).map((f) => [f.name, f.value]))
    expect(fields.Store).toBe("Target")
    expect(fields.Price).toBe("$59.99")
    expect(fields.SKU).toBe("93954435")
    expect(fields.Link).toContain("https://www.target.com/p/-/A-93954435")
    expect(embed.author.name).toContain("Zzz AIO")
    expect(embed.author.icon_url).toContain("/docs/brand/stores/target.png")
    expect(embed.footer.text).toContain("Zzz AIO")
  })

  it("uses red for out of stock", () => {
    const embed = buildDiscordBody({ kind: "oos", storeName: "Walmart", sku: "123", profileName: "Monitor", detail: "" }).embeds[0] as Record<string, any>
    expect(embed.color).toBe(0xff4d6d)
    expect(embed.title).toContain("Out of stock")
  })

  it("only alerts on a change, and respects the cooldown", () => {
    let cooldown = 10 * 60_000
    const alerts = new StockAlerts(() => cooldown)
    const key = stockKey("target", "93954435")
    expect(alerts.read(key, false, 0)).toBeNull()
    expect(alerts.read(key, false, 1000)).toBeNull()
    expect(alerts.read(key, true, 2000)).toBe("instock")
    expect(alerts.read(key, true, 3000)).toBeNull()
    expect(alerts.read(key, false, 4000)).toBe("oos")
    expect(alerts.read(key, true, 5000)).toBeNull()
    expect(alerts.read(key, false, 6000)).toBe("oos")
    expect(alerts.read(key, true, 2000 + cooldown + 1)).toBe("instock")
    cooldown = 0
    alerts.read(key, false, 9e9)
    expect(alerts.read(key, true, 9e9 + 1)).toBe("instock")
  })

  it("follows the Settings > Notifications toggles", () => {
    expect(noticeAllowed(DEFAULT_SETTINGS, { kind: "instock" })).toBe(true)
    expect(noticeAllowed(DEFAULT_SETTINGS, { kind: "oos" })).toBe(false)
    expect(noticeAllowed(DEFAULT_SETTINGS, { kind: "blocked" })).toBe(false)
    expect(noticeAllowed(DEFAULT_SETTINGS, { kind: "success" })).toBe(true)
    expect(noticeAllowed({ ...DEFAULT_SETTINGS, notifyFailed: false }, { kind: "failure" })).toBe(false)
    expect(noticeAllowed({}, { kind: "instock" })).toBe(true)
  })

  it("moves an old per-task webhook to the global setting only when the global one is empty", () => {
    const hook = "https://discord.com/api/webhooks/1/abc"
    expect(migrateTaskWebhook({ ...DEFAULT_SETTINGS, discordWebhook: "" }, [{ webhook: "" }, { webhook: hook }])?.discordWebhook).toBe(hook)
    expect(migrateTaskWebhook({ ...DEFAULT_SETTINGS, discordWebhook: "https://discord.com/api/webhooks/2/x" }, [{ webhook: hook }])).toBeNull()
    expect(migrateTaskWebhook({ ...DEFAULT_SETTINGS, discordWebhook: "" }, [{}])).toBeNull()
  })
})
