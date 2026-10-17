import { describe, expect, it } from "vitest"
import { attachSession, backoffMs, isBlockStatus, resetBlockRecoveryState, selectProxy, sendWithRecovery } from "../src/engine/block-recovery"
import {
  adaptiveDelay,
  detectChanges,
  inDropWindow,
  MonitorHub,
  monitorPlaces,
  parseDropWindows,
  suggestWarmups,
  summarizeMonitor,
  type WatchSnapshot
} from "../src/engine/monitor"
import { DEFAULT_SETTINGS, type ProxyEndpoint, type Settings } from "../src/shared/types"
import type { StoreRunContext } from "../src/stores/module"

const base = { ...DEFAULT_SETTINGS, monitorDelayMs: 8000, monitorFastDelayMs: 1000, dropWindows: "09:00-09:30" }

describe("monitor timing and locations", () => {
  it("polls faster inside a drop window and stays above the store gap", () => {
    const morning = Date.parse("2026-10-16T13:10:00Z")
    const afternoon = Date.parse("2026-10-16T18:00:00Z")
    expect(inDropWindow(morning, parseDropWindows("09:00-09:30"), [])).toBe(true)
    expect(inDropWindow(afternoon, parseDropWindows("09:00-09:30"), [])).toBe(false)
    const fast = adaptiveDelay("target", morning, base, [], 0.5)
    const slow = adaptiveDelay("target", afternoon, base, [], 0.5)
    expect(fast).toBeLessThan(slow)
    expect(fast).toBeGreaterThanOrEqual(3000)
    expect(inDropWindow(afternoon, [], [{ startAt: afternoon, stopAt: afternoon + 60_000, enabled: true }])).toBe(true)
  })

  it("checks each configured ZIP and store id, up to four", () => {
    const places = monitorPlaces({ ...DEFAULT_SETTINGS, targetZip: "10001", targetStoreId: "1881", monitorZips: "90210, 10001", monitorStoreIds: "3244" })
    expect(places.map((place) => place.zip)).toEqual(["10001", "90210"])
    expect(places[1]?.storeId).toBe("3244")
    expect(monitorPlaces({ ...DEFAULT_SETTINGS, monitorZips: "1, 2, 3, 4, 5", monitorStoreIds: "" })).toHaveLength(1)
  })
})

describe("stock changes and restock memory", () => {
  const hidden: WatchSnapshot = { inStock: false, price: 49.99, offerId: "old", soldByRetailer: false, purchasable: false, title: "ETB" }
  const open: WatchSnapshot = { inStock: true, price: 44.99, offerId: "new", soldByRetailer: true, purchasable: true, title: "ETB" }

  it("reports price, offer, availability, and retailer changes", () => {
    const flags = { price: true, offer: true, available: true, retailer: true }
    expect(detectChanges(null, open, flags)).toEqual([])
    const messages = detectChanges(hidden, open, flags)
    expect(messages.join(" ")).toContain("price changed")
    expect(messages.join(" ")).toContain("new offer")
    expect(messages.join(" ")).toContain("added to cart")
    expect(messages.join(" ")).toContain("sold by the retailer")
    expect(detectChanges(hidden, open, { price: false, offer: false, available: true, retailer: false })).toHaveLength(1)
  })

  it("suggests a warm-up after the same hour repeats", () => {
    const at = Date.parse("2026-10-16T13:05:00Z")
    const hints = suggestWarmups([
      { store: "target", sku: "88897904", at, price: 49.99, title: "ETB" },
      { store: "target", sku: "88897904", at: at + 60_000, price: 49.99, title: "ETB" }
    ])
    expect(hints).toHaveLength(1)
    expect(hints[0]?.warmupMin).toBe(15)
    expect(hints[0]?.hourAst).toBe(9)
    expect(suggestWarmups([{ store: "target", sku: "1", at, price: null, title: "" }])).toEqual([])
  })

  it("summarizes monitor speed and block rate", () => {
    const stats = summarizeMonitor([
      { store: "target", ms: 100, blocked: false, at: 1 },
      { store: "target", ms: 300, blocked: true, at: 2 },
      { store: "bandai", ms: 200, blocked: false, at: 3 }
    ])
    expect(stats.samples).toBe(3)
    expect(stats.blocked).toBe(1)
    expect(stats.avgMs).toBe(200)
    expect(stats.byStore.find((row) => row.store === "target")?.blockRate).toBe(0.5)
  })
})

describe("shared monitor", () => {
  it("fans one request out to every waiter", async () => {
    const hub = new MonitorHub()
    let calls = 0
    const load = () => {
      calls += 1
      return Promise.resolve({ status: 200, body: "ok" })
    }
    const [first, second] = await Promise.all([hub.share("target:1", load), hub.share("target:1", load)])
    expect(first).toEqual(second)
    expect(calls).toBe(1)
    await hub.share("target:1", load)
    expect(calls).toBe(2)
  })
})

describe("block recovery", () => {
  it("rotates after a block and does not treat a product queue as a block", async () => {
    resetBlockRecoveryState()
    expect(backoffMs(1, 1000, 0)).toBe(500)
    expect(backoffMs(3, 1000, 1)).toBe(4000)
    expect(isBlockStatus(403)).toBe(true)
    expect(isBlockStatus(429, { headers: {}, body: "PLEASE_WAIT" })).toBe(false)
    const proxies: ProxyEndpoint[] = [
      { id: "a", host: "10.0.0.1", port: 8000 },
      { id: "b", host: "10.0.0.2", port: 8000 }
    ]
    expect(selectProxy("acct", proxies, 0)?.id).toBe("a")
    const seen: string[] = []
    let tries = 0
    const ctx = fakeCtx(proxies)
    const applied: string[] = []
    attachSession(ctx, (cookies) => applied.push(cookies.accessToken))
    const response = await sendWithRecovery(ctx, { method: "GET", url: "https://example.test/stock" }, {
      homeUrl: "https://example.test/",
      inner: {
        request: async (input) => {
          tries += 1
          seen.push(input.proxy?.id ?? "")
          return tries < 2 ? { status: 403, headers: {}, body: "access denied" } : { status: 200, headers: {}, body: "ok" }
        }
      },
      blocked: (result) => isBlockStatus(result.status, result)
    })
    expect(response.status).toBe(200)
    expect(seen).toEqual(["a", "b"])
    expect(applied).toEqual(["fresh"])
    expect(ctx.proxy?.id).toBe("b")
  })
})

function fakeCtx(proxies: ProxyEndpoint[]): StoreRunContext {
  return {
    task: { id: "t", sku: "1", quantity: 1, store: "target" },
    profile: {} as StoreRunContext["profile"],
    account: { id: "acct", store: "target", label: "a", username: "u" },
    settings: { ...DEFAULT_SETTINGS, blockRetries: 3, monitorDelayMs: 1000 } as Settings,
    proxy: proxies[0],
    proxies,
    signal: new AbortController().signal,
    http: { request: async () => ({ status: 500, headers: {}, body: "" }) },
    log: () => undefined,
    detail: () => undefined,
    phase: () => undefined,
    sleep: async () => undefined,
    onSession: async () => undefined,
    refreshSession: async () => ({ cookies: { accessToken: "fresh" }, challenged: false })
  }
}
