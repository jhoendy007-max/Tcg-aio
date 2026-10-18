import { clientIdOf } from "./clients"
import { AppError } from "./errors"
import type { StoreId, TaskInput } from "./types"

export interface QuickSetupInput {
  store: StoreId
  sku: string
  keywords: string
  profileId: string
  accountId: string
  proxyGroupId: string | null
  quantity: number
  testMode: boolean
  confirmPurchase: boolean
  group?: string
  /** Monitor owner. A blank value is the default Me client. The checkout uses the account's client. */
  clientId?: string
}

export interface QuickPair {
  monitor: TaskInput
  checkout: TaskInput
}

/** A monitor that never checks out, plus one checkout that starts when that monitor sees stock. */
export function planQuickPair(input: QuickSetupInput): QuickPair {
  const sku = input.sku.trim()
  const keywords = input.keywords.trim()
  if (!sku && !keywords) throw new AppError("Enter a SKU, a URL, or keywords.")
  if (!input.profileId) throw new AppError("Choose a profile.")
  if (!input.accountId) throw new AppError("Choose an account.")
  const quantity = clampQuantity(input.quantity)
  const group = (input.group ?? "Quick").trim().slice(0, 40) || "Quick"
  const monitor: TaskInput = {
    store: input.store,
    sku,
    quantity: 1,
    profileId: "",
    accountId: "",
    proxyGroupId: null,
    monitorProxyGroupId: input.proxyGroupId,
    confirmPurchase: false,
    testMode: false,
    group,
    monitorOnly: true,
    kind: "monitor",
    keywords,
    startMode: "manual",
    linkedCheckoutIds: [],
    clientId: clientIdOf(input.clientId)
  }
  const checkout: TaskInput = {
    store: input.store,
    sku,
    quantity,
    profileId: input.profileId,
    accountId: input.accountId,
    proxyGroupId: input.proxyGroupId,
    confirmPurchase: input.confirmPurchase === true && input.testMode !== true,
    testMode: input.testMode === true,
    group,
    monitorOnly: false,
    kind: "checkout",
    keywords,
    startMode: "monitor"
  }
  return { monitor, checkout }
}

/** Another checkout on the same monitor, for a second account. */
export function planExtraCheckout(
  monitor: { id: string; store: StoreId; sku: string; keywords?: string; proxyGroupId: string | null; group?: string },
  input: { profileId: string; accountId: string; quantity: number; testMode: boolean; confirmPurchase: boolean }
): TaskInput {
  if (!monitor.id) throw new AppError("Create the monitor first.")
  if (!input.profileId) throw new AppError("Choose a profile.")
  if (!input.accountId) throw new AppError("Choose an account.")
  return {
    store: monitor.store,
    sku: monitor.sku,
    quantity: clampQuantity(input.quantity),
    profileId: input.profileId,
    accountId: input.accountId,
    proxyGroupId: monitor.proxyGroupId,
    confirmPurchase: input.confirmPurchase === true && input.testMode !== true,
    testMode: input.testMode === true,
    group: monitor.group ?? "Quick",
    monitorOnly: false,
    kind: "checkout",
    keywords: monitor.keywords ?? "",
    startMode: "monitor",
    linkedMonitorId: monitor.id
  }
}

function clampQuantity(value: number): number {
  const quantity = Math.round(Number(value))
  if (!Number.isInteger(quantity) || quantity < 1) return 1
  return Math.min(12, quantity)
}
