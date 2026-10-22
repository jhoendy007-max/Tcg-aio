import { describe, expect, it } from "vitest"
import { testProxiesAgainstStores } from "../src/engine/proxy-test"
import type { HttpRequest } from "../src/engine/http"
import { STORE_IDS } from "../src/shared/types"

describe("proxy store test", () => {
  it("sends one monitor request per store and labels OK or Blocked", async () => {
    const seen: string[] = []
    const proxy = { id: "p1", host: "13.141.190.3", port: 28067 }
    const results = await testProxiesAgainstStores([proxy], {
      async request(input: HttpRequest) {
        seen.push(input.url)
        expect(input.proxy?.host).toBe("13.141.190.3")
        expect(input.method).toBe("GET")
        expect(input.url).not.toMatch(/cart|checkout|place-order/i)
        if (input.url.includes("redsky.target.com")) {
          const url = new URL(input.url)
          expect(url.searchParams.get("key")).toBeTruthy()
          expect(url.searchParams.get("visitor_id")).toMatch(/^[0-9A-F]{32}$/)
          expect(url.searchParams.get("pricing_store_id")).toBeTruthy()
          expect(input.headers?.["x-requested-with"]).toBeUndefined()
          expect(input.headers?.accept).toBe("application/json")
          expect(input.headers?.origin).toBe("https://www.target.com")
          return { status: 435, headers: {}, body: "" }
        }
        if (input.url.includes("walmart.com")) return { status: 200, headers: {}, body: "<html>ok</html>" }
        return { status: 403, headers: {}, body: "access denied" }
      }
    })
    expect(seen).toHaveLength(STORE_IDS.length)
    expect(new Set(seen).size).toBe(STORE_IDS.length)
    const probes = results[0]?.probes ?? []
    expect(probes).toHaveLength(STORE_IDS.length)
    expect(probes.find((probe) => probe.store === "target")).toMatchObject({ verdict: "blocked", detail: "Blocked" })
    expect(probes.find((probe) => probe.store === "walmart")).toMatchObject({ verdict: "ok", detail: "OK" })
    expect(probes.find((probe) => probe.store === "bestbuy")?.verdict).toBe("blocked")
  })
})
