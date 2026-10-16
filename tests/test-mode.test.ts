import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { checkStoreHealth } from "../src/engine/health"
import type { HttpRequest } from "../src/engine/http"
import { FinalSubmitBlocked, guardTestMode, isFinalSubmit } from "../src/engine/test-mode"
import { TaskService } from "../src/engine/task-runner"
import { STORE_IDS, type StoreId } from "../src/shared/types"
import type { StoreModule } from "../src/stores/module"

const final: Record<StoreId, HttpRequest> = {
  target: { method: "POST", url: "https://carts.target.com/web_checkouts/v1/checkout?key=abc", body: "{\"cart_type\":\"REGULAR\"}" },
  walmart: { method: "POST", url: "https://www.walmart.com/orchestra/cartxo/graphql/placeOrder/hash", body: "{\"placeOrderInput\":{}}" },
  bestbuy: { method: "POST", url: "https://www.bestbuy.com/checkout/v3/order-1", body: "{\"metadata\":{}}" },
  "pokemon-center": { method: "POST", url: "https://www.pokemoncenter.com/tpci-ecommweb-api/order?format=nodatalinks", body: "{}" },
  amazon: { method: "POST", url: "https://www.amazon.com/checkout/p/spc/place-order", body: "place=1" },
  crunchyroll: { method: "POST", url: "https://www.crunchyroll.com/mobify/proxy/api/checkout/shopper-orders/v1/organizations/org/orders?siteId=CrunchyrollUS", body: "{\"basketId\":\"b\"}" }
}

const allowed: Record<StoreId, HttpRequest> = {
  target: { method: "POST", url: "https://carts.target.com/checkout_payments/v1/payment_instructions?key=abc", body: "{\"card_details\":{}}" },
  walmart: { method: "POST", url: "https://www.walmart.com/orchestra/home/graphql/CreateAccountCreditCard/hash", body: "{\"input\":{}}" },
  bestbuy: { method: "PATCH", url: "https://www.bestbuy.com/checkout/v3/order-1", body: "{\"shipping\":{}}" },
  "pokemon-center": { method: "POST", url: "https://flex.cybersource.com/flex/v2/tokens", body: "jwe" },
  amazon: { method: "GET", url: "https://www.amazon.com/checkout/entry/cart?proceedToCheckout=1" },
  crunchyroll: { method: "POST", url: "https://api.stripe.com/v1/payment_methods", body: "card[number]=4242" }
}

describe("place-order gate", () => {
  it("recognizes only the final submit for every store", () => {
    for (const store of STORE_IDS) {
      expect(isFinalSubmit(store, final[store]), store).toBe(true)
      expect(isFinalSubmit(store, allowed[store]), store).toBe(false)
    }
    expect(isFinalSubmit("bestbuy", { method: "POST", url: "https://www.bestbuy.com/checkout/v3/order-1/paymentMethods/refreshPayments" })).toBe(false)
    expect(isFinalSubmit("crunchyroll", { method: "POST", url: "https://www.crunchyroll.com/mobify/proxy/api/checkout/shopper-baskets/v1/organizations/org/baskets/b/payment-instruments?siteId=CrunchyrollUS" })).toBe(false)
  })

  it("never calls the inner client for a place-order request", async () => {
    const seen: string[] = []
    const inner = {
      async request(input: HttpRequest) {
        seen.push(input.url)
        return { status: 200, headers: {}, body: "should not run" }
      }
    }
    for (const store of STORE_IDS) {
      const guarded = guardTestMode(store, inner)
      await expect(guarded.request(final[store])).rejects.toBeInstanceOf(FinalSubmitBlocked)
      await expect(guarded.request(allowed[store])).resolves.toMatchObject({ status: 200 })
    }
    expect(seen).toEqual(STORE_IDS.map((store) => allowed[store].url))
    expect(seen.some((url) => url.includes("/placeOrder/") || url.includes("/web_checkouts/v1/checkout") || url.includes("place-order"))).toBe(false)
  })

  it("stops a task runner from delivering a place-order request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-test-mode-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const profile = db.saveProfile({
      name: "Home",
      email: "ada@example.com",
      phone: "2125550100",
      shipping: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
      billing: { firstName: "Ada", lastName: "Lovelace", line1: "1 Main St", line2: "", city: "New York", state: "NY", zip: "10001", country: "US" },
      cardName: "Ada Lovelace",
      cardNumber: "4242424242424242",
      expMonth: "12",
      expYear: "2030",
      cvv: "123",
      cardAction: "replace"
    })
    const account = db.saveAccount({
      store: "target",
      label: "Main",
      username: "ada@example.com",
      password: "",
      passwordAction: "clear",
      session: "accessToken=token-1; visitorId=visitor-1",
      sessionAction: "replace"
    })
    const task = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: profile.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: false,
      testMode: true
    })
    const seen: string[] = []
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        await ctx.http.request(final.target)
        return { outcome: "success", detail: "charged" }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false, {
      async request(input) {
        seen.push(input.url)
        return { status: 200, headers: {}, body: "" }
      }
    })
    service.start(task.id)
    await service.wait(task.id)
    expect(seen).toEqual([])
    expect(db.getTask(task.id).status).toBe("failed")
    expect(db.getTask(task.id).detail).toMatch(/blocked the target place-order/i)
  })
})

describe("store health check", () => {
  it("sends one read-only GET per store and never a place-order request", async () => {
    const calls: HttpRequest[] = []
    const report = await checkStoreHealth({
      async request(input) {
        calls.push(input)
        if (input.url.includes("walmart")) return { status: 412, headers: {}, body: "px-captcha" }
        return { status: 200, headers: {}, body: "ok" }
      }
    }, [{ id: "p", host: "10.0.0.1", port: 8000 }])
    expect(calls).toHaveLength(STORE_IDS.length)
    expect(calls.every((call) => call.method === "GET")).toBe(true)
    expect(calls.every((call) => call.proxy?.host === "10.0.0.1")).toBe(true)
    expect(calls.some((call) => STORE_IDS.some((store) => isFinalSubmit(store, call)))).toBe(false)
    expect(report.find((row) => row.store === "walmart")?.verdict).toBe("challenge")
    expect(report.find((row) => row.store === "target")?.verdict).toBe("up")
  })
})
