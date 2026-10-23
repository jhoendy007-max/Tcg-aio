import { describe, expect, it } from "vitest"
import { BENCH_SKUS, isBlocked, isTimeout, monitorReadUrl, probeMonitor, readMonitor } from "../src/engine/bench"
import type { HttpClient } from "../src/engine/http"
import { readSite, testProxiesOnSite } from "../src/engine/site-test"
import { cleanSiteUrl, STORE_SITES } from "../src/shared/store-sites"
import { COSTCO, parsePageTarget } from "../src/stores/page/parse"
import { STORE_IDS, type ProxyEndpoint } from "../src/shared/types"

const proxy = (id: string): ProxyEndpoint => ({ id, host: `10.0.0.${id}`, port: 8000 } as ProxyEndpoint)

describe("monitor benchmark (0.2.37)", () => {
  it("every store has a real product id that builds a monitor URL", () => {
    for (const store of STORE_IDS) expect(monitorReadUrl(store, BENCH_SKUS[store]), store).toMatch(/^https:\/\//)
    expect(BENCH_SKUS.costco).not.toBe("100000001")
    expect(BENCH_SKUS.sams).not.toBe("980000001")
  })

  it("treats 3xx and challenge pages as blocked", () => {
    expect(isBlocked(302, "")).toBe(true)
    expect(isBlocked(307, "")).toBe(true)
    expect(isBlocked(200, "<title>Just a moment...</title>")).toBe(true)
    expect(isBlocked(200, "{\"data\":{}}")).toBe(false)
    expect(readMonitor("costco", BENCH_SKUS.costco, 302, "").verdict).toBe("blocked")
  })

  it("reads in-stock / out-of-stock / parse-error with the store parser", () => {
    const page = (availability: string) => `<script type="application/ld+json">{"@type":"Product","name":"Charizard ex Super-Premium Collection","offers":{"@type":"Offer","price":"49.99","availability":"https://schema.org/${availability}"}}</script>`
    expect(readMonitor("costco", BENCH_SKUS.costco, 200, page("InStock")).verdict).toBe("in")
    expect(readMonitor("costco", BENCH_SKUS.costco, 200, page("OutOfStock")).verdict).toBe("oos")
    expect(readMonitor("costco", BENCH_SKUS.costco, 200, "<html>nothing here</html>").verdict).toBe("parse-error")
  })

  it("reports a timeout separately", async () => {
    expect(isTimeout(new Error("Request timed out after 8000ms"))).toBe(true)
    const slow: HttpClient = { request: async () => { throw new Error("The request timed out.") } }
    expect((await probeMonitor(slow, "target", BENCH_SKUS.target)).verdict).toBe("timeout")
  })

  it("parses the new Costco /p/ product URLs", () => {
    expect(parsePageTarget(COSTCO, "https://www.costco.com/p/-/pokmon-tcg-charizard-ex-super-premium-collection/4000313298")?.sku).toBe("4000313298")
    expect(parsePageTarget(COSTCO, "4000313298")?.url).toBe("https://www.costco.com/p/-/product/4000313298")
  })
})

describe("proxy site test (0.2.37)", () => {
  it("lists a main website for every store and only allows https custom URLs", () => {
    for (const store of STORE_IDS) expect(STORE_SITES[store]).toMatch(/^https:\/\//)
    expect(cleanSiteUrl("https://www.target.com/")).toBe("https://www.target.com/")
    expect(cleanSiteUrl("http://example.com")).toBeNull()
    expect(cleanSiteUrl("https://127.0.0.1/")).toBeNull()
    expect(cleanSiteUrl("https://localhost/")).toBeNull()
  })

  it("classifies works / blocked by status, captcha redirect, and captcha page", () => {
    expect(readSite(200, "", "<html>Target</html>").verdict).toBe("works")
    expect(readSite(301, "https://www.target.com/", "").verdict).toBe("works")
    expect(readSite(307, "https://www.samsclub.com/are-you-human?url=x", "").verdict).toBe("blocked")
    expect(readSite(403, "", "").verdict).toBe("blocked")
    expect(readSite(200, "", "<div id=px-captcha>").verdict).toBe("blocked")
  })

  it("shows the response time in ms for every proxy that answered, blocked ones included", async () => {
    const http: HttpClient = {
      request: async (input) => {
        const id = input.proxy?.id
        if (id === "3") throw new Error("Request timed out")
        return { status: id === "2" ? 403 : 200, headers: {}, body: "<html></html>", timing: { dnsMs: 1, connectMs: 2, ttfbMs: 3, totalMs: id === "2" ? 455.4 : 312 } }
      }
    }
    const rows = await testProxiesOnSite(http, [proxy("1"), proxy("2"), proxy("3")], "https://www.target.com/")
    expect(rows.map((row) => [row.verdict, row.ms])).toEqual([["works", 312], ["blocked", 455], ["timeout", null]])
  })
})
