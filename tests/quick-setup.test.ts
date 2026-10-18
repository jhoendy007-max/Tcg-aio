import { describe, expect, it } from "vitest"
import { accountsToWarm } from "../src/engine/session-care"
import { planExtraCheckout, planQuickPair } from "../src/shared/quick-setup"

describe("quick setup", () => {
  it("plans a monitor and a checkout that waits for that monitor", () => {
    const pair = planQuickPair({
      store: "target",
      sku: "88897904",
      keywords: "elite trainer",
      profileId: "profile-1",
      accountId: "account-1",
      proxyGroupId: "proxies",
      quantity: 2,
      testMode: true,
      confirmPurchase: true
    })
    expect(pair.monitor).toMatchObject({
      kind: "monitor",
      monitorOnly: true,
      confirmPurchase: false,
      profileId: "",
      accountId: "",
      monitorProxyGroupId: "proxies",
      proxyGroupId: null,
      keywords: "elite trainer",
      startMode: "manual"
    })
    expect(pair.checkout).toMatchObject({
      kind: "checkout",
      startMode: "monitor",
      profileId: "profile-1",
      accountId: "account-1",
      proxyGroupId: "proxies",
      quantity: 2,
      testMode: true,
      confirmPurchase: false,
      keywords: "elite trainer"
    })
  })

  it("adds a second account as another checkout on the same monitor", () => {
    const extra = planExtraCheckout({
      id: "mon-1",
      store: "pokemon-center",
      sku: "sku-1",
      keywords: "booster",
      proxyGroupId: null,
      group: "Quick"
    }, {
      profileId: "profile-2",
      accountId: "account-2",
      quantity: 1,
      testMode: false,
      confirmPurchase: true
    })
    expect(extra).toMatchObject({
      store: "pokemon-center",
      linkedMonitorId: "mon-1",
      accountId: "account-2",
      startMode: "monitor",
      confirmPurchase: true,
      testMode: false
    })
  })

  it("requires a product and refuses a real order while test mode is on", () => {
    expect(() => planQuickPair({
      store: "target",
      sku: " ",
      keywords: "",
      profileId: "p",
      accountId: "a",
      proxyGroupId: null,
      quantity: 1,
      testMode: true,
      confirmPurchase: false
    })).toThrow(/SKU/)
    const pair = planQuickPair({
      store: "walmart",
      sku: "",
      keywords: "prismatic",
      profileId: "p",
      accountId: "a",
      proxyGroupId: null,
      quantity: 99,
      testMode: true,
      confirmPurchase: true
    })
    expect(pair.checkout.quantity).toBe(12)
    expect(pair.checkout.confirmPurchase).toBe(false)
    expect(pair.monitor.sku).toBe("")
    expect(pair.monitor.keywords).toBe("prismatic")
  })
})

describe("session warm targets", () => {
  const now = 1_000_000

  it("warms a stale checkout account when its monitor starts, and skips a fresh one", () => {
    const monitor = { id: "mon", accountId: "", kind: "monitor" as const, linkedCheckoutIds: ["co-1"] }
    const tasks = [
      { id: "co-1", accountId: "acct-1", linkedMonitorId: "mon" },
      { id: "co-2", accountId: "acct-2", linkedMonitorId: "mon" }
    ]
    const accounts = [
      { id: "acct-1", lastWarmAt: null },
      { id: "acct-2", lastWarmAt: now - 60_000 }
    ]
    expect(accountsToWarm(monitor, tasks, accounts, now, 30)).toEqual(["acct-1"])
    expect(accountsToWarm({ id: "co-2", accountId: "acct-2", kind: "checkout" }, tasks, accounts, now, 30)).toEqual([])
  })
})
