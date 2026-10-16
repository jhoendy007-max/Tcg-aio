import { describe, expect, it } from "vitest"
import { luhnOk } from "../src/shared/card"
import { parseProxyLine, parseProxyList } from "../src/shared/proxy"
import { redact } from "../src/shared/redact"
import { parseTcin } from "../src/shared/tcin"
import { assertDiscordWebhook, buildDiscordBody } from "../src/engine/discord"
import { parseSession } from "../src/engine/session"
import { isChallenge, parseStock } from "../src/stores/target/parse"

describe("parseTcin", () => {
  it("reads a bare TCIN and a product URL", () => {
    expect(parseTcin("88897904")).toBe("88897904")
    expect(parseTcin("https://www.target.com/p/pokemon-etb/-/A-88897904")).toBe("88897904")
    expect(parseTcin("https://www.target.com/p/x/-/A-88897904#lnk=sametab")).toBe("88897904")
    expect(parseTcin("not a product")).toBeNull()
  })
})

describe("proxies", () => {
  it("parses the common list formats", () => {
    const parsed = parseProxyList("# comment\n203.0.113.10:8000\n203.0.113.11:8000:user:p:ass\nuser:secret@203.0.113.12:9000\nhttp://user:secret@203.0.113.13:9000\n")
    expect(parsed.skipped).toEqual([])
    expect(parsed.proxies.map((proxy) => `${proxy.host}:${proxy.port}:${proxy.username ?? ""}:${proxy.password ?? ""}`)).toEqual([
      "203.0.113.10:8000::",
      "203.0.113.11:8000:user:p:ass",
      "203.0.113.12:9000:user:secret",
      "203.0.113.13:9000:user:secret"
    ])
    expect(parseProxyLine("nope")).toBeNull()
  })
})

describe("cards and redaction", () => {
  it("checks luhn and strips secrets", () => {
    expect(luhnOk("4242424242424242")).toBe(true)
    expect(luhnOk("4242424242424243")).toBe(false)
    const hidden = redact('{"card_number":"4242424242424242","cvv":"123","password":"hunter2"} accessToken=abc refreshToken=def Bearer tok.en')
    expect(hidden).not.toContain("4242424242424242")
    expect(hidden).not.toContain("hunter2")
    expect(hidden).not.toContain("accessToken=abc")
  })
})

describe("discord webhooks", () => {
  it("allows Discord webhook URLs only", () => {
    expect(() => assertDiscordWebhook("")).not.toThrow()
    expect(() => assertDiscordWebhook("https://discord.com/api/webhooks/1/token")).not.toThrow()
    expect(() => assertDiscordWebhook("https://example.com/api/webhooks/1/token")).toThrow()
    expect(() => assertDiscordWebhook("http://discord.com/api/webhooks/1/token")).toThrow()
  })

  it("does not put a card number in the notification body", () => {
    const body = buildDiscordBody({
      kind: "success",
      storeName: "Target",
      sku: "88897904",
      profileName: "Home",
      detail: "charged 4242424242424242",
      orderId: "100"
    })
    expect(JSON.stringify(body)).not.toContain("4242424242424242")
    expect(JSON.stringify(body)).toContain("Order: 100")
  })
})

describe("sessions and stock", () => {
  it("parses a cookie string and JSON session", () => {
    expect(parseSession("accessToken=aaa; visitorId=bbb; refreshToken=ccc").accessToken).toBe("aaa")
    expect(parseSession('{"access_token":"zzz","visitor_id":"yyy"}').visitorId).toBe("yyy")
    expect(() => parseSession("visitorId=only")).toThrow(/accessToken/)
  })

  it("reads shipping stock from current and legacy payloads", () => {
    expect(parseStock(JSON.stringify({
      data: {
        product_summaries: [{
          item: { product_description: { title: "Pokemon ETB" } },
          fulfillment: { sold_out: false, shipping_options: { availability_status: "IN_STOCK" } }
        }]
      }
    }))).toMatchObject({ inStock: true, status: "IN_STOCK", title: "Pokemon ETB" })
    expect(parseStock(JSON.stringify({
      data: { product: { fulfillment: { shipping_options: { availability_status: "OUT_OF_STOCK" } } } }
    }))).toMatchObject({ inStock: false, status: "OUT_OF_STOCK" })
    expect(parseStock(JSON.stringify({
      data: { product_summaries: [{ fulfillment: { sold_out: true, shipping_options: { availability_status: "IN_STOCK" } } }] }
    }))).toMatchObject({ inStock: false, status: "SOLD_OUT" })
  })

  it("detects a challenge page and ignores product copy", () => {
    expect(isChallenge(403, "<html>captcha</html>")).toBe(true)
    expect(isChallenge(435, '{"blockScript":"https://captcha.px-cdn.net/x/captcha.js"}')).toBe(true)
    expect(isChallenge(200, "this product is a challenge coin")).toBe(false)
    expect(isChallenge(201, "added")).toBe(false)
  })
})
