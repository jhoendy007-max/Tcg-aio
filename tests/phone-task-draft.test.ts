import { describe, expect, it } from "vitest"
import { projectProxyGroup, projectTask } from "../src/phone/protocol"
import { asList, draftFromPhoneTask, emptyPhoneDraft, textField, withStoreDefaults } from "../src/phone/task-draft"
import type { PublicTask } from "../src/shared/types"

describe("phone create task", () => {
  it("opens a new task when store, profile, account, proxy, and task lists are missing", () => {
    const snap = { pcName: "PC", tasks: undefined, profiles: undefined, accounts: undefined, proxyGroups: undefined, stores: undefined }
    expect(() => emptyPhoneDraft(snap)).not.toThrow()
    const draft = emptyPhoneDraft(snap)
    expect(draft.kind).toBe("checkout")
    expect(draft.store).toBe("target")
    expect(draft.sku).toBe("")
    expect(draft.profileId).toBe("")
    expect(draft.accountId).toBe("")
    expect(textField(draft.sku)).toBe("")
    expect(textField(undefined)).toBe("")
    expect(textField(null)).toBe("")
    expect(asList(undefined)).toEqual([])
    expect(asList(null)).toEqual([])
  })

  it("keeps an empty first-time snapshot on the checkout form and applies a store default", () => {
    const draft = emptyPhoneDraft({
      stores: [],
      profiles: [],
      accounts: [],
      proxyGroups: [],
      tasks: [],
      storeRoles: { target: { checkout: { quantity: 2, testMode: true, maxPrice: 40 } } }
    })
    expect(draft.quantity).toBe(2)
    expect(draft.testMode).toBe(true)
    expect(draft.maxPrice).toBe(40)
    expect(draft.sku).toBe("")
  })

  it("does not throw when an edited task is missing text fields", () => {
    const draft = draftFromPhoneTask({ id: "task-1", store: "target", sku: undefined, kind: "checkout" })
    expect(draft.id).toBe("task-1")
    expect(draft.sku).toBe("")
    const kept = withStoreDefaults({ ...draft, quantity: 4 }, { target: { checkout: { quantity: 9 } } })
    expect(kept.quantity).toBe(4)
  })

  it("projects a task and a proxy group that have no logs or proxies", () => {
    const task = { id: "t", store: "target", sku: "1", quantity: 1, profileId: "", accountId: "", proxyGroupId: null, confirmPurchase: false, status: "idle", detail: "", createdAt: 1 } as PublicTask
    expect(projectTask(task, [], [], []).logs).toEqual([])
    expect(projectProxyGroup({ id: "g", name: "Direct", proxies: undefined as unknown as [] }).count).toBe(0)
  })
})
