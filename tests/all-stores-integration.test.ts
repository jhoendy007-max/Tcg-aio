import { describe, expect, it } from "vitest"
import { createRegistry } from "../src/stores/registry"
import { classifyChallenge } from "../src/engine/challenge"
import { guardTestMode, isFinalSubmit } from "../src/engine/test-mode"
import { DEFAULT_SETTINGS, type FullAccount, type FullProfile, type StoreId } from "../src/shared/types"
import type { HttpClient, HttpRequest } from "../src/engine/http"
import type { StoreRunContext } from "../src/stores/module"

const SKUS: Record<StoreId, string> = {
  target: "https://www.target.com/p/-/A-88897904",
  walmart: "https://www.walmart.com/ip/5123456789",
  bestbuy: "6575371",
  "pokemon-center": "https://www.pokemoncenter.com/product/100-10019/pokemon-tcg",
  amazon: "B0CX1Y2Z3A",
  crunchyroll: "196214154117",
  bandai: "https://p-bandai.com/us/item/N2797466001001",
  gamestop: "https://www.gamestop.com/toys-games/trading-cards/products/x/20012345.html",
  "barnes-noble": "https://www.barnesandnoble.com/w/x/1146574246",
  costco: "4000313298",
  sams: "https://www.samsclub.com/ip/x/19170800669",
  tcgplayer: "https://www.tcgplayer.com/product/543210"
}

const profile: FullProfile = {
  id: "p1", name: "Home", email: "ada@example.com", phone: "2125550100",
  shipping: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
  billing: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
  cardName: "Ada Lovelace", last4: "4242", expMonth: "12", expYear: "2030",
  card: { name: "Ada Lovelace", number: "4242424242424242", cvv: "123", expMonth: "12", expYear: "2030" }
}

function ctx(store: StoreId, http: HttpClient): StoreRunContext {
  const account: FullAccount = { id: "a1", store, label: "Main", username: "ada@example.com", session: { accessToken: "t", visitorId: "v", refreshToken: "r", cookie: "session=abc; _px3=old; at-main=Atza|x; session-id=1; ubid-main=2" } }
  return {
    task: { id: "t1", sku: SKUS[store], quantity: 1, store },
    profile, account,
    settings: { ...DEFAULT_SETTINGS, monitorDelayMs: 1 },
    signal: AbortSignal.timeout(5000),
    http,
    testMode: true,
    log: () => undefined, detail: () => undefined, phase: () => undefined,
    sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))), onSession: async () => undefined
  } as StoreRunContext
}

const PX = "<html><head><title>Access Denied</title></head><body><div id=\"px-captcha\"></div>Press &amp; Hold to confirm you are a human (and not a bot). perimeterx captcha</body></html>"

// Amazon uses its own robot check, not PerimeterX.
const AMAZON_ROBOT = "<html><head><title>Robot Check</title></head><body>Type the characters you see in this image. /errors/validateCaptcha</body></html>"

describe("every store: a bot check pauses for a person and routes to the challenge handoff (0.2.40)", () => {
  for (const [store, module] of createRegistry()) {
    it(`${store}`, async () => {
      const calls: HttpRequest[] = []
      const http: HttpClient = { async request(req) { if (calls.length < 500) calls.push(req); await new Promise((r) => setTimeout(r, 1)); return { status: 403, headers: { "content-type": "text/html" }, body: store === "amazon" ? AMAZON_ROBOT : PX } } }
      const result = await module.run(ctx(store, http))
      expect(calls.some((c) => /checkout|placeorder|place-order|submit/i.test(c.url) && c.method === "POST" && /order/i.test(c.url))).toBe(false)
      expect(result.outcome, `${store}: ${JSON.stringify(result)}`).toBe("paused")
      if (result.outcome === "paused") expect(classifyChallenge(result.reason), `${store} reason not routed to the handoff: ${result.reason}`).toBe(true)
    })
  }
})

describe("every store: dry run never lets place order reach the network (0.2.40)", () => {
  for (const [store, module] of createRegistry()) {
    it(`${store}`, async () => {
      const sent: HttpRequest[] = []
      // Permissive fake store: everything answers 200 with an empty JSON body. Only final submits are kept.
      const inner: HttpClient = { async request(req) { if (isFinalSubmit(store, req)) sent.push(req); await new Promise((r) => setTimeout(r, 1)); return { status: 200, headers: { "content-type": "application/json" }, body: "{}" } } }
      const run = { ...ctx(store, guardTestMode(store, inner)), signal: AbortSignal.timeout(1500), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5))) } as StoreRunContext
      const result = await module.run(run).catch((err: unknown) => ({ outcome: "error", err: String(err) }))
      expect(sent.filter((req) => isFinalSubmit(store, req)), `${store}: ${JSON.stringify(result).slice(0, 200)}`).toEqual([])
    })
  }
})
