import { beforeEach, describe, expect, it } from "vitest"
import {
  attachSession,
  backoffMs,
  blockRetryBudget,
  isBlockStatus,
  pageLooksLikeChallenge,
  proxyKey,
  resetBlockRecoveryState,
  selectProxy,
  sendWithRecovery
} from "../src/engine/block-recovery"
import type { HttpRequest, HttpResponse } from "../src/engine/http"
import { DEFAULT_SETTINGS, type SessionCookies } from "../src/shared/types"
import type { StoreRunContext } from "../src/stores/module"
import { createTargetModule, TARGET_PAUSE } from "../src/stores/target"

const proxies = [
  { id: "a", host: "10.0.0.1", port: 8000 },
  { id: "b", host: "10.0.0.2", port: 8001 }
]

function json(status: number, body: unknown, headers: HttpResponse["headers"] = {}): HttpResponse {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body) }
}

function ctx(overrides: Partial<StoreRunContext> = {}): StoreRunContext {
  return {
    task: { id: "t1", sku: "88897904", quantity: 1, store: "target" },
      profile: { shipping: { country: "US" } } as StoreRunContext["profile"],
    account: { id: "acct-target", store: "target" } as StoreRunContext["account"],
    settings: { ...DEFAULT_SETTINGS, monitorDelayMs: 1000, blockRetries: 3 },
    proxies,
    proxy: proxies[0],
    signal: new AbortController().signal,
    http: { request: async () => json(200, {}) },
    log: () => undefined,
    detail: () => undefined,
    phase: () => undefined,
    sleep: async () => undefined,
    onSession: async () => undefined,
    ...overrides
  }
}

describe("block recovery", () => {
  beforeEach(() => resetBlockRecoveryState())

  it("backs off with jitter inside half to all of the delay", () => {
    expect(backoffMs(1, 1000, 0)).toBe(500)
    expect(backoffMs(1, 1000, 1)).toBe(1000)
    expect(backoffMs(2, 1000, 0)).toBe(1000)
    expect(backoffMs(2, 1000, 1)).toBe(2000)
    expect(blockRetryBudget({ ...DEFAULT_SETTINGS, blockRetries: 0 })).toBe(3)
    expect(blockRetryBudget({ ...DEFAULT_SETTINGS, blockRetries: 8 })).toBe(8)
  })

  it("keeps an account on a healthy proxy and moves a different account independently", () => {
    const first = selectProxy("target:acct-target", proxies, 0)
    const again = selectProxy("target:acct-target", proxies, 0)
    const other = selectProxy("walmart:acct-target", proxies, 0)
    expect(proxyKey(first)).toBe(proxyKey(proxies[0]))
    expect(proxyKey(again)).toBe(proxyKey(proxies[0]))
    expect(proxyKey(other)).toBe(proxyKey(proxies[0]))
  })

  it("does not treat a Best Buy please-wait 429 as a block", () => {
    const queued = json(429, { errorCode: "CONSTRAINED_ITEM_DHV" }, { a2ctransactionwait: "7" })
    expect(isBlockStatus(429, queued)).toBe(false)
    expect(isBlockStatus(429, json(429, "slow down"))).toBe(true)
    expect(isBlockStatus(403)).toBe(true)
    expect(isBlockStatus(412)).toBe(true)
    expect(isBlockStatus(435)).toBe(true)
    expect(isBlockStatus(500)).toBe(false)
    expect(pageLooksLikeChallenge("Please verify you are a human")).toBe(true)
    expect(pageLooksLikeChallenge("Pokemon ETB in stock")).toBe(false)
  })

  it("rotates, copies the cookies the browser returned, and retries", async () => {
    const seen: HttpRequest[] = []
    let hits = 0
    const saved: SessionCookies[] = []
    let jar = "accessToken=old; visitorId=old-visitor"
    const http = {
      async request(input: HttpRequest) {
        seen.push(input)
        hits += 1
        if (hits === 1) return json(435, { blockScript: "captcha" })
        return json(200, { ok: true })
      }
    }
    const run = ctx({
      http,
      refreshSession: async (input) => {
        expect(input.proxy?.host).toBe("10.0.0.2")
        return {
          cookies: { accessToken: "fresh-token", visitorId: "fresh-visitor", cookie: "accessToken=fresh-token; visitorId=fresh-visitor" },
          challenged: false
        }
      },
      onSession: async (cookies) => {
        saved.push(cookies)
      }
    })
    attachSession(run, (cookies) => {
      if (cookies.cookie) jar = cookies.cookie
    })
    const response = await sendWithRecovery(run, {
      method: "GET",
      url: "https://redsky.target.com/stock",
      headers: { cookie: jar, authorization: "Bearer old" }
    }, {
      homeUrl: "https://www.target.com/",
      inner: http,
      blocked: (result) => isBlockStatus(result.status, result)
    })
    expect(response.status).toBe(200)
    expect(seen[0]?.proxy?.host).toBe("10.0.0.1")
    expect(seen[1]?.proxy?.host).toBe("10.0.0.2")
    expect(seen[1]?.headers?.cookie).toContain("fresh-token")
    expect(seen[1]?.headers?.authorization).toBe("Bearer fresh-token")
    expect(saved[0]?.accessToken).toBe("fresh-token")
    expect(jar).toContain("fresh-visitor")
    const stuck = selectProxy("target:acct-target", proxies, Date.now())
    expect(stuck?.host).toBe("10.0.0.2")
  })

  it("pauses Target on a challenge page before adding to cart", async () => {
    const calls: string[] = []
    const result = await createTargetModule().run(ctx({
      account: {
        id: "acct-pause",
        store: "target",
        label: "Main",
        username: "ada@example.com",
        session: { accessToken: "token-1", visitorId: "visitor-1" }
      } as StoreRunContext["account"],
      task: { id: "t1", sku: "88897904", quantity: 1, store: "target" },
      http: {
        async request(input) {
          calls.push(input.url)
          return json(403, "<html>captcha</html>")
        }
      }
    }))
    expect(result).toMatchObject({ outcome: "paused", reason: TARGET_PAUSE })
    expect(calls.some((url) => url.includes("cart_items"))).toBe(false)
  })
})
