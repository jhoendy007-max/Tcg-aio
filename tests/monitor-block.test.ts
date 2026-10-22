import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { TaskService } from "../src/engine/task-runner"
import {
  isBlockStatus,
  monitorBlockWait,
  resetBlockRecoveryState,
  sendWithRecovery,
  SINGLE_PROXY_WARNING,
  storeBlockedLine
} from "../src/engine/block-recovery"
import type { HttpRequest, HttpResponse } from "../src/engine/http"
import { DEFAULT_SETTINGS, type ProxyEndpoint } from "../src/shared/types"
import { retryWait, type StoreModule, type StoreRunContext } from "../src/stores/module"
import { createTargetModule } from "../src/stores/target"

const two: ProxyEndpoint[] = [
  { id: "a", host: "10.0.0.1", port: 8000 },
  { id: "b", host: "10.0.0.2", port: 8001 }
]
const one: ProxyEndpoint[] = [{ id: "solo", host: "13.141.190.3", port: 28067 }]

function json(status: number, body: unknown): HttpResponse {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function inStock() {
  return {
    data: {
      product_summaries: [{
        tcin: "88897904",
        item: { product_description: { title: "Pokemon ETB" } },
        fulfillment: { shipping_options: { availability_status: "IN_STOCK" } }
      }]
    }
  }
}

interface Harness {
  ctx: StoreRunContext
  logs: Array<{ level: string; message: string }>
  waits: number[]
  hosts: string[]
}

function harness(proxies: ProxyEndpoint[], respond: (req: HttpRequest, hit: number) => HttpResponse, stopAfter = 50): Harness {
  const logs: Harness["logs"] = []
  const waits: number[] = []
  const hosts: string[] = []
  const controller = new AbortController()
  let hit = 0
  const inner = {
    async request(req: HttpRequest) {
      hit += 1
      hosts.push(req.proxy?.host ?? "direct")
      if (hit >= stopAfter) controller.abort()
      return respond(req, hit)
    }
  }
  const ctx: StoreRunContext = {
    task: { id: "m1", sku: "88897904", quantity: 1, store: "target" },
    profile: { shipping: { country: "US" } } as StoreRunContext["profile"],
    account: { id: "", store: "target" } as StoreRunContext["account"],
    settings: { ...DEFAULT_SETTINGS, monitorDelayMs: 2000, blockRetries: 3 },
    proxies,
    proxy: proxies[0],
    monitorOnly: true,
    signal: controller.signal,
    http: inner,
    refreshSession: async () => {
      throw new Error("an anonymous monitor must never reload a store session")
    },
    log: (level, message) => logs.push({ level, message }),
    detail: () => undefined,
    phase: () => undefined,
    sleep: async (ms) => { waits.push(ms) },
    onSession: async () => {
      throw new Error("an anonymous monitor must never save a session")
    }
  }
  ctx.http = {
    request: (req) => sendWithRecovery(ctx, req, {
      homeUrl: "https://www.target.com/",
      inner,
      blocked: (response) => isBlockStatus(response.status, response)
    })
  }
  return { ctx, logs, waits, hosts }
}

describe("anonymous monitor blocks (0.2.33)", () => {
  beforeEach(() => resetBlockRecoveryState())

  it("rotates to the next proxy on 435 without reloading a session", async () => {
    const h = harness(two, (_req, hit) => (hit === 1 ? json(435, "") : json(200, inStock())), 3)
    const first = await h.ctx.http.request({ method: "GET", url: "https://redsky.target.com/x" })
    expect(first.status).toBe(435)
    const second = await h.ctx.http.request({ method: "GET", url: "https://redsky.target.com/x" })
    expect(second.status).toBe(200)
    expect(h.hosts).toEqual(["10.0.0.1", "10.0.0.2"])
    expect(h.logs.some((l) => l.message === storeBlockedLine("target", 435))).toBe(true)
    expect(h.logs.some((l) => /reloading|embedded browser|saved session/i.test(l.message))).toBe(false)
  })

  it("uses the plain per-store block message", () => {
    expect(storeBlockedLine("target", 435)).toBe("Target blocked this proxy (HTTP 435). Add more residential proxies to the group or try another one.")
    expect(storeBlockedLine("walmart", 403)).toBe("Walmart blocked this proxy (HTTP 403). Add more residential proxies to the group or try another one.")
    expect(SINGLE_PROXY_WARNING).toBe("This group has 1 proxy. Stores block a single proxy quickly.")
  })

  it("backs off exponentially with one proxy, never below the monitor delay, capped at two minutes", async () => {
    const h = harness(one, () => json(435, ""))
    expect(monitorBlockWait(h.ctx, 2000, 1)).toBe(2000)
    const waits: number[] = []
    for (let i = 0; i < 10; i += 1) {
      await h.ctx.http.request({ method: "GET", url: "https://redsky.target.com/x" })
      waits.push(monitorBlockWait(h.ctx, 2000, 1))
    }
    expect(waits.slice(0, 5)).toEqual([2000, 4000, 8000, 16000, 32000])
    expect(Math.max(...waits)).toBe(120_000)
    for (const wait of waits) expect(wait).toBeGreaterThanOrEqual(2000)
    expect(retryWait(h.ctx)).toBeLessThanOrEqual(120_000)
  })

  it("keeps the normal delay with several proxies and resets after a good response", async () => {
    const h = harness(two, (_req, hit) => (hit <= 2 ? json(435, "") : json(200, {})))
    await h.ctx.http.request({ method: "GET", url: "https://redsky.target.com/x" })
    expect(monitorBlockWait(h.ctx, 2000)).toBe(2000)
    const single = harness(one, (_req, hit) => (hit <= 2 ? json(435, "") : json(200, {})))
    await single.ctx.http.request({ method: "GET", url: "https://redsky.target.com/x" })
    await single.ctx.http.request({ method: "GET", url: "https://redsky.target.com/x" })
    expect(monitorBlockWait(single.ctx, 2000, 1)).toBe(4000)
    await single.ctx.http.request({ method: "GET", url: "https://redsky.target.com/x" })
    expect(monitorBlockWait(single.ctx, 2000, 1)).toBe(2000)
  })

  it("keeps a Target monitor running through repeated 435s until it is stopped", async () => {
    const h = harness(one, () => json(435, ""), 25)
    const result = await createTargetModule().run(h.ctx)
    expect(result.outcome).not.toBe("paused")
    expect(result.outcome).not.toBe("failed")
    expect(h.hosts.length).toBeGreaterThanOrEqual(25)
    expect(h.logs.some((l) => /reloading the store session|No embedded browser/i.test(l.message))).toBe(false)
    expect(h.logs.filter((l) => l.message === storeBlockedLine("target", 435)).length).toBeGreaterThan(5)
    expect(Math.max(...h.waits)).toBeLessThanOrEqual(120_000)
    expect(h.waits.some((w) => w > 2000)).toBe(true)
  })

  it("finds stock again once the block clears", async () => {
    let calls = 0
    const h = harness(one, () => {
      calls += 1
      return calls <= 4 ? json(435, "") : json(200, inStock())
    }, 40)
    let seen = false
    h.ctx.observe = (snapshot) => { if (snapshot.inStock) seen = true }
    await createTargetModule().run(h.ctx)
    expect(seen).toBe(true)
  })

  it("warns when a monitor starts with a one-proxy group, and not with two", async () => {
    for (const [text, expected] of [["13.141.190.3:28067", true], ["10.0.0.1:8000\n10.0.0.2:8000", false]] as const) {
      const dir = mkdtempSync(join(tmpdir(), "tcgaio-single-"))
      const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
      db.load()
      const group = db.saveProxyGroup({ name: "Pool", text, network: "residential" })
      const task = db.saveTask({ store: "target", sku: "88897904", quantity: 1, profileId: "", accountId: "", proxyGroupId: group.id, kind: "monitor", monitorOnly: true } as Parameters<Database["saveTask"]>[0])
      let usedRefresh = false
      const module: StoreModule = {
        id: "target",
        displayName: "Target",
        skuHint: "TCIN",
        implemented: true,
        async run(ctx) {
          usedRefresh = Boolean(ctx.refreshSession)
          return { outcome: "stopped", reason: "done" }
        }
      }
      const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false)
      service.start(task.id)
      await service.wait(task.id)
      const logs = db.getTask(task.id).logs.map((l) => l.message)
      expect(logs.includes(SINGLE_PROXY_WARNING)).toBe(expected)
      expect(usedRefresh).toBe(false)
    }
  })
})
