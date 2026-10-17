import { describe, expect, it } from "vitest"
import { buildGroupBody, postGroupDiscord } from "../src/engine/discord"
import type { HttpClient } from "../src/engine/http"
import { DEFAULT_SETTINGS, type Notice } from "../src/shared/types"

const webhook = "https://discord.com/api/webhooks/123/abc"
const leak = "Paid with 4242424242424242 cvv 123 password secret-pass ada@example.com accessToken=token-1 proxy user:secret-proxy@proxy.example"

const success: Notice = {
  kind: "success",
  storeName: "Target",
  sku: "88897904",
  profileName: "Ada Lovelace",
  detail: leak,
  price: 49.99,
  orderId: "A-100",
  url: "https://www.target.com/p/88897904"
}

function capture(): { http: HttpClient; bodies: string[] } {
  const bodies: string[] = []
  return {
    bodies,
    http: {
      async request(input) {
        bodies.push(input.body ?? "")
        return { status: 204, headers: {}, body: "" }
      }
    }
  }
}

describe("group discord", () => {
  it("stays silent until the user opts in, then posts a redacted restock or success", async () => {
    const off = capture()
    expect(await postGroupDiscord({ ...DEFAULT_SETTINGS, groupWebhook: webhook }, success, off.http)).toBe(false)
    expect(off.bodies).toHaveLength(0)
    const watched = capture()
    expect(await postGroupDiscord({ ...DEFAULT_SETTINGS, groupDiscord: true, groupWebhook: webhook }, { ...success, kind: "failure" }, watched.http)).toBe(false)
    expect(await postGroupDiscord({ ...DEFAULT_SETTINGS, groupDiscord: true, groupWebhook: webhook }, { ...success, kind: "tested" }, watched.http)).toBe(false)
    expect(await postGroupDiscord({ ...DEFAULT_SETTINGS, groupDiscord: true, groupWebhook: webhook }, { ...success, kind: "alert", inStock: false }, watched.http)).toBe(false)
    expect(watched.bodies).toHaveLength(0)

    const on = capture()
    expect(await postGroupDiscord({ ...DEFAULT_SETTINGS, groupDiscord: true, groupWebhook: webhook }, success, on.http)).toBe(true)
    expect(await postGroupDiscord({ ...DEFAULT_SETTINGS, groupDiscord: true, groupWebhook: webhook }, { ...success, kind: "alert", inStock: true }, on.http)).toBe(true)
    expect(on.bodies).toHaveLength(2)
    for (const body of on.bodies) {
      expect(body).not.toContain("4242424242424242")
      expect(body).not.toContain("secret-pass")
      expect(body).not.toContain("ada@example.com")
      expect(body).not.toContain("token-1")
      expect(body).not.toContain("secret-proxy")
      expect(body).not.toContain("Ada Lovelace")
      expect(body).toContain("88897904")
    }
    const parsed = JSON.parse(on.bodies[0] ?? "{}") as { embeds: Array<{ description: string }> }
    expect(parsed.embeds[0]?.description).not.toContain("Profile:")
    expect(buildGroupBody(success).embeds[0]?.description).toContain("[card]")
    expect(buildGroupBody(success).embeds[0]?.description).toContain("[email]")
  })
})
