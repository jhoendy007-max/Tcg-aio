import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { TaskService } from "../src/engine/task-runner"
import { addressKey, assessCheckout, isCardDecline, issueText, type HealthProfile, type HealthWorld } from "../src/shared/checkout-health"
import type { Address, Notice, StoreId } from "../src/shared/types"
import { checkoutPreflight, type StoreModule, type StoreRunContext } from "../src/stores/module"

const now = Date.now()

function address(over: Partial<Address> = {}): Address {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    line1: "1 Main St",
    line2: "",
    city: "New York",
    state: "NY",
    zip: "10001",
    country: "US",
    ...over
  }
}

function profile(over: Partial<HealthProfile> = {}): HealthProfile {
  const shipping = over.shipping ?? address()
  const billing = over.billing ?? shipping
  return {
    id: "p1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    phone: "2125550100",
    cardName: "Ada Lovelace",
    last4: "4242",
    clientId: "me",
    ...over,
    shipping,
    billing
  }
}

function world(over: Partial<HealthWorld> = {}): HealthWorld {
  return {
    profiles: [profile()],
    accounts: [{ id: "a1", clientId: "me", hasSession: true, sessionState: "saved", lastWarmAt: now }],
    tasks: [],
    checkouts: [],
    declines: [],
    now,
    freshMin: 30,
    block: false,
    skuLimit: 0,
    declineHoldMin: 1440,
    addressOrderLimits: "",
    addressWindowStart: 0,
    ...over
  }
}

function subject(over: Partial<Parameters<typeof assessCheckout>[1]> = {}) {
  return {
    store: "target" as StoreId,
    sku: "88897904",
    quantity: 1,
    profileId: "p1",
    accountId: "a1",
    clientId: "me",
    ...over
  }
}

describe("checkout health", () => {
  it("warns on an incomplete profile and blocks only when asked", () => {
    const profiles = [profile({ email: "" })]
    const open = assessCheckout(world({ profiles }), subject())
    expect(open.blocked).toBe(false)
    expect(open.issues.map((item) => item.code)).toContain("profile-incomplete")
    const closed = assessCheckout(world({ profiles, block: true }), subject())
    expect(closed.blocked).toBe(true)
    expect(closed.issues.find((item) => item.code === "profile-incomplete")?.level).toBe("block")
  })

  it("flags a profile or card name that does not match shipping", () => {
    const profiles = [profile({ name: "Home" })]
    const report = assessCheckout(world({ profiles }), subject())
    expect(report.issues.map((item) => item.code)).toContain("name-mismatch")
    expect(issueText("es", report.issues[0])).toMatch(/no coincide/)
  })

  it("flags a billing address that differs from shipping", () => {
    const shipping = address()
    const profiles = [profile({ shipping, billing: address({ line1: "9 Oak Ave", zip: "10002" }) })]
    const report = assessCheckout(world({ profiles }), subject())
    expect(report.issues.map((item) => item.code)).toEqual(["address-mismatch"])
  })

  it("counts successes and active tasks against the client, address, and card", () => {
    const shipping = address()
    const me = profile({ id: "p-me", shipping, billing: shipping, last4: "4242" })
    const otherShipping = address({ firstName: "Grace", lastName: "Hopper", line1: "9 Oak Ave", zip: "10002" })
    const other = profile({
      id: "p-other",
      clientId: "north",
      name: "Grace Hopper",
      cardName: "Grace Hopper",
      last4: "1111",
      shipping: otherShipping,
      billing: otherShipping
    })
    const shared = profile({
      id: "p-shared",
      clientId: "south",
      name: "Grace Hopper",
      cardName: "Grace Hopper",
      last4: "4242",
      shipping,
      billing: shipping
    })
    const base = world({
      profiles: [me, other, shared],
      skuLimit: 2,
      checkouts: [
        { outcome: "success", store: "target", sku: "88897904", quantity: 1, clientId: "me", profileId: "p-me", last4: "4242" }
      ],
      tasks: [{
        id: "active",
        store: "target",
        sku: "88897904",
        quantity: 1,
        clientId: "me",
        profileId: "p-me",
        accountId: "a1",
        status: "monitoring"
      }]
    })
    const client = assessCheckout(base, subject({ taskId: "this", profileId: "p-me" }))
    expect(client.issues.find((item) => item.code === "limit-client")?.vars).toMatchObject({ used: 2, limit: 2 })

    const cardHit = assessCheckout(world({
      profiles: [me, other],
      skuLimit: 2,
      checkouts: [
        { outcome: "success", store: "target", sku: "88897904", quantity: 2, clientId: "north", profileId: "p-other", last4: "4242" }
      ]
    }), subject({ profileId: "p-me", taskId: "this" }))
    expect(cardHit.issues.find((item) => item.code === "limit-card")?.vars).toMatchObject({ last4: "4242", used: 2, limit: 2 })
  })

  it("blocks the fourth order to the same shipping address at one store", () => {
    const shipping = address()
    const street = address({ line1: "1 Main Street" })
    const profiles = [
      profile({ id: "p-me", shipping, billing: shipping }),
      profile({ id: "p-a", clientId: "north", name: "Grace Hopper", cardName: "Grace Hopper", last4: "1111", shipping: street, billing: street }),
      profile({ id: "p-b", clientId: "south", name: "Grace Hopper", cardName: "Grace Hopper", last4: "2222", shipping: street, billing: street }),
      profile({ id: "p-c", clientId: "east", name: "Grace Hopper", cardName: "Grace Hopper", last4: "3333", shipping, billing: shipping })
    ]
    expect(addressKey(shipping)).toBe(addressKey(street))
    const orders = ["p-a", "p-b", "p-c"].map((profileId, index) => ({
      outcome: "success",
      store: "target" as const,
      sku: `sku-${index}`,
      quantity: 4,
      clientId: "other",
      profileId,
      at: now
    }))
    const blocked = assessCheckout(world({ profiles, checkouts: orders, block: false, skuLimit: 0 }), subject({ profileId: "p-me" }))
    const addressIssue = blocked.issues.find((item) => item.code === "limit-address")
    expect(addressIssue?.level).toBe("block")
    expect(addressIssue?.vars).toMatchObject({ used: 3, limit: 3 })
    expect(blocked.blocked).toBe(true)
    expect(issueText("en", addressIssue!).includes("1 Main")).toBe(false)

    const under = assessCheckout(world({ profiles, checkouts: orders.slice(0, 2) }), subject({ profileId: "p-me" }))
    expect(under.issues.map((item) => item.code)).not.toContain("limit-address")

    const otherStore = orders.map((row) => ({ ...row, store: "walmart" as const }))
    const walmart = assessCheckout(world({ profiles, checkouts: otherStore }), subject({ profileId: "p-me", store: "target" }))
    expect(walmart.issues.map((item) => item.code)).not.toContain("limit-address")

    const tighter = assessCheckout(world({
      profiles,
      checkouts: orders.slice(0, 2),
      addressOrderLimits: "target:2"
    }), subject({ profileId: "p-me" }))
    expect(tighter.issues.find((item) => item.code === "limit-address")?.vars).toMatchObject({ used: 2, limit: 2 })

    const moduleCap = assessCheckout(world({
      profiles,
      checkouts: [orders[0]],
      addressOrderLimits: "target:5",
      moduleAddressCaps: { target: 1 }
    }), subject({ profileId: "p-me" }))
    expect(moduleCap.blocked).toBe(true)
    expect(moduleCap.issues.find((item) => item.code === "limit-address")?.vars).toMatchObject({ used: 1, limit: 1 })

    const beforeDrop = assessCheckout(world({
      profiles,
      addressWindowStart: now,
      checkouts: orders.map((row) => ({ ...row, at: now - 60_000 }))
    }), subject({ profileId: "p-me" }))
    expect(beforeDrop.issues.map((item) => item.code)).not.toContain("limit-address")

    const active = assessCheckout(world({
      profiles,
      checkouts: orders.slice(0, 2),
      tasks: [{
        id: "live",
        store: "target",
        sku: "other",
        quantity: 1,
        clientId: "north",
        profileId: "p-a",
        accountId: "a9",
        status: "checking_out"
      }]
    }), subject({ profileId: "p-me", taskId: "this" }))
    expect(active.issues.find((item) => item.code === "limit-address")?.vars).toMatchObject({ used: 3, limit: 3 })
  })

  it("warns when another client already uses the address or card", () => {
    const shipping = address()
    const me = profile({ id: "p-me", shipping, billing: shipping, last4: "4242" })
    const other = profile({ id: "p-other", clientId: "north", name: "Grace Hopper", cardName: "Grace Hopper", last4: "4242", shipping, billing: shipping })
    const report = assessCheckout(world({ profiles: [me, other], skuLimit: 0 }), subject({ profileId: "p-me" }))
    const codes = report.issues.map((item) => item.code)
    expect(codes).toContain("duplicate-address")
    expect(codes).toContain("duplicate-card")
    expect(report.blocked).toBe(false)
    const text = report.issues.map((item) => issueText("en", item)).join(" ")
    expect(text).not.toContain("1 Main St")
    expect(text).toContain("4242")
  })

  it("reuses warm-up status for a cold or logged-out session", () => {
    expect(assessCheckout(world(), subject()).issues.map((item) => item.code)).not.toContain("session-cold")
    const cold = assessCheckout(world({
      accounts: [{ id: "a1", hasSession: true, sessionState: "saved", lastWarmAt: null }]
    }), subject())
    expect(cold.issues.map((item) => item.code)).toContain("session-cold")
    const loggedOut = assessCheckout(world({
      accounts: [{ id: "a1", hasSession: true, sessionState: "expired", lastWarmAt: now }]
    }), subject())
    expect(loggedOut.issues.map((item) => item.code)).toContain("session-out")
  })

  it("stops the same task after one decline and holds the card for other tasks", () => {
    const decline = { taskId: "t1", last4: "4242", at: now, store: "target" as const, sku: "88897904" }
    const same = assessCheckout(world({ declines: [decline], block: false }), subject({ taskId: "t1" }))
    expect(same.blocked).toBe(true)
    expect(same.issues[0]?.code).toBe("decline-task")
    expect(issueText("en", same.issues[0])).toMatch(/will not be tried again/)

    const recent = assessCheckout(world({ declines: [decline] }), subject({ taskId: "t2" }))
    expect(recent.blocked).toBe(false)
    expect(recent.issues.map((item) => item.code)).toContain("decline-recent")
    const held = assessCheckout(world({ declines: [decline], block: true }), subject({ taskId: "t2" }))
    expect(held.blocked).toBe(true)

    const old = assessCheckout(world({
      declines: [{ ...decline, at: now - 2000 * 60_000 }]
    }), subject({ taskId: "t2" }))
    expect(old.issues.map((item) => item.code)).not.toContain("decline-recent")
  })

  it("recognizes a payment decline", () => {
    expect(isCardDecline("Target declined the card.")).toBe(true)
    expect(isCardDecline("payment_declined")).toBe(true)
    expect(isCardDecline("card_declined")).toBe(true)
    expect(isCardDecline("out of stock")).toBe(false)
  })

  it("does not run a checkout again after that card is declined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-health-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const shipping = address()
    const profileRow = db.saveProfile({
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "2125550100",
      shipping,
      billing: shipping,
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
    db.saveSettings({ ...db.getSettings(), sessionWarmupMin: 30 })
    const warmed = db.listAccounts().find((item) => item.id === account.id)
    expect(warmed?.hasSession).toBe(true)
    const task = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: profileRow.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: true
    })
    let runs = 0
    const notices: Notice[] = []
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run() {
        runs += 1
        return { outcome: "failed", reason: "Target declined the card." }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async (notice) => {
      notices.push(notice)
      return true
    })
    service.start(task.id)
    await service.wait(task.id)
    expect(runs).toBe(1)
    expect(notices.some((notice) => /will not be tried again/.test(notice.detail))).toBe(true)
    expect(db.listCheckouts()[0]?.detail).toMatch(/will not be tried again/)
    expect(() => service.start(task.id)).toThrow(/will not be tried again/)
    expect(runs).toBe(1)

    const again = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    again.load()
    expect(again.assessTask(task.id).blocked).toBe(true)
  })

  it("blocks a mismatched profile before the store module runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-health-block-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const shipping = address()
    const profileRow = db.saveProfile({
      name: "Home",
      email: "ada@example.com",
      phone: "2125550100",
      shipping,
      billing: shipping,
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
      session: "accessToken=token-1",
      sessionAction: "replace"
    })
    const task = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: profileRow.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: true
    })
    db.saveSettings({ ...db.getSettings(), checkoutHealthBlock: true })
    let runs = 0
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run() {
        runs += 1
        return { outcome: "success", detail: "should not run" }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false)
    expect(() => service.start(task.id)).toThrow(/does not match/)
    expect(runs).toBe(0)
  })

  it("pauses inside checkout preflight when the address cap is reached while the task is running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-health-preflight-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const shipping = address()
    const profileRow = db.saveProfile({
      name: "Ada Lovelace",
      email: "ada@example.com",
      phone: "2125550100",
      shipping,
      billing: shipping,
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
      password: "secret",
      passwordAction: "replace",
      session: "accessToken=token-1; visitorId=visitor-1",
      sessionAction: "replace"
    })
    const task = db.saveTask({
      store: "target",
      sku: "88897904",
      quantity: 1,
      profileId: profileRow.id,
      accountId: account.id,
      proxyGroupId: null,
      confirmPurchase: true
    })
    const module: StoreModule = {
      id: "target",
      displayName: "Target",
      skuHint: "TCIN",
      implemented: true,
      async run(ctx) {
        for (let n = 0; n < 3; n += 1) {
          db.recordCheckout({
            store: "target",
            sku: "other",
            product: "Other",
            outcome: "success",
            profileName: "Ada Lovelace",
            detail: "Order",
            accountId: account.id,
            profileId: profileRow.id,
            quantity: 1,
            clientId: "me"
          })
        }
        return checkoutPreflight(ctx, 20) ?? { outcome: "success" as const, detail: "should not place" }
      }
    }
    const service = new TaskService(db, new Map([["target", module]]), () => undefined, async () => false)
    service.start(task.id)
    await service.wait(task.id)
    expect(db.getTask(task.id).status).toBe("paused")
    expect(db.getTask(task.id).detail).toMatch(/already has 3 orders/)
  })

  it("asks checkout preflight for a verified price after the health check passes", () => {
    const health = checkoutPreflight({
      testMode: false,
      task: { id: "t", sku: "1", quantity: 1, store: "target", maxPrice: 10 },
      healthCheck: () => ({ ok: false, reason: "This shipping address already has 3 orders at this store. The limit is 3." })
    } as StoreRunContext)
    expect(health).toMatchObject({ outcome: "paused" })
    expect(health?.reason).toMatch(/3 orders/)
    const price = checkoutPreflight({
      testMode: false,
      task: { id: "t", sku: "1", quantity: 1, store: "target", maxPrice: 10 },
      healthCheck: () => ({ ok: true })
    } as StoreRunContext)
    expect(price?.reason).toMatch(/verified price/)
  })
})
