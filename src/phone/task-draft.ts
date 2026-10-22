import type { PhoneSnapshot, PhoneTask, PhoneTaskDraft } from "./protocol"
import { prefillRole, type StoreRoles } from "../shared/store-defaults"
import { isStoreId } from "../shared/stores"
import type { StartMode, StoreId, TaskKind } from "../shared/types"

/** A missing list is an empty list. Indexing `snap?.stores[0]` throws when `stores` itself is missing. */
export function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}

/** Android closes the app when a TextInput value is null or undefined. */
export function textField(value: unknown): string {
  if (typeof value === "string") return value
  if (value == null) return ""
  return String(value)
}

export function emptyPhoneDraft(snap: Partial<PhoneSnapshot> | null | undefined): PhoneTaskDraft {
  const stores = asList<{ id?: string }>(snap?.stores)
  const profiles = asList<{ id?: string }>(snap?.profiles)
  const storeId = stores.find((store) => typeof store?.id === "string" && isStoreId(store.id))?.id
  return withStoreDefaults({
    store: storeId && isStoreId(storeId) ? storeId : "target",
    sku: "",
    quantity: 1,
    profileId: profiles.find((profile) => typeof profile?.id === "string")?.id ?? "",
    accountId: "",
    proxyGroupId: null,
    confirmPurchase: false,
    testMode: false,
    kind: "checkout",
    keywords: "",
    priceCap: null,
    webhook: "",
    activeHours: "",
    linkedCheckoutIds: [],
    checkoutDelayMs: null,
    maxPrice: null,
    startMode: "builtin",
    jitterPct: null
  }, snap?.storeRoles)
}

export function draftFromPhoneTask(item: Partial<PhoneTask> | null | undefined): PhoneTaskDraft {
  const store = typeof item?.store === "string" && isStoreId(item.store) ? item.store : "target"
  const kind: TaskKind = item?.kind === "monitor" || item?.monitorOnly ? "monitor" : "checkout"
  return {
    id: item?.id,
    store,
    sku: textField(item?.sku),
    quantity: Number(item?.quantity) || 1,
    profileId: kind === "monitor" ? "" : textField(item?.profileId),
    accountId: kind === "monitor" ? "" : textField(item?.accountId),
    proxyGroupId: item?.proxyGroupId ?? null,
    confirmPurchase: item?.confirmPurchase === true,
    testMode: item?.testMode === true,
    group: textField(item?.group),
    kind,
    keywords: textField(item?.keywords),
    priceCap: item?.priceCap ?? null,
    webhook: textField(item?.webhook),
    activeHours: textField(item?.activeHours),
    linkedCheckoutIds: asList<string>(item?.linkedCheckoutIds),
    checkoutDelayMs: item?.checkoutDelayMs ?? null,
    maxPrice: item?.maxPrice ?? null,
    startMode: item?.startMode ?? (kind === "monitor" ? "manual" : "builtin"),
    linkedMonitorId: item?.linkedMonitorId ?? null,
    jitterPct: item?.jitterPct ?? null,
    monitorProxyGroupId: item?.monitorProxyGroupId ?? null,
    overrides: item?.overrides
  }
}

/** New tasks pick up the store's saved defaults. An open task keeps the numbers already on it. */
export function withStoreDefaults(draft: PhoneTaskDraft, roles: StoreRoles | undefined, kind: TaskKind = draft.kind === "monitor" ? "monitor" : "checkout"): PhoneTaskDraft {
  const store: StoreId = isStoreId(draft.store) ? draft.store : "target"
  const startMode: StartMode = kind === "monitor"
    ? (draft.startMode === "scheduled" ? "scheduled" : "manual")
    : (draft.startMode ?? "builtin")
  const next: PhoneTaskDraft = {
    ...draft,
    store,
    kind,
    sku: textField(draft.sku),
    keywords: textField(draft.keywords),
    webhook: textField(draft.webhook),
    activeHours: textField(draft.activeHours),
    profileId: textField(draft.profileId),
    accountId: kind === "monitor" ? "" : textField(draft.accountId),
    quantity: Number(draft.quantity) || 1,
    confirmPurchase: kind === "monitor" ? false : draft.confirmPurchase === true,
    startMode,
    linkedMonitorId: kind === "monitor" ? null : draft.linkedMonitorId ?? null,
    linkedCheckoutIds: asList<string>(draft.linkedCheckoutIds)
  }
  if (draft.id) return next
  try {
    const role = prefillRole(store, kind === "monitor" ? "monitor" : "checkout", roles)
    return {
      ...next,
      quantity: role.quantity || next.quantity,
      maxPrice: role.maxPrice,
      checkoutDelayMs: role.checkoutDelayMs,
      testMode: role.testMode
    }
  } catch (err) {
    console.error(err)
    return next
  }
}

export function phoneTaskStatus(snap: Partial<PhoneSnapshot> | null | undefined, id?: string): string {
  if (!id) return "idle"
  return asList<PhoneTask>(snap?.tasks).find((task) => task?.id === id)?.status ?? "idle"
}
