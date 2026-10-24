import type { PublicTask, StoreId, TaskInput } from "../shared/types"

export interface CloneAccount {
  id: string
  store: StoreId
  proxyGroupId?: string | null
}

/** One copy per selected account. The account's proxy group is kept. The task's proxy group is not. */
export function clonedTaskInputs(task: PublicTask, accounts: CloneAccount[]): { inputs: TaskInput[]; skipped: string[] } {
  const inputs: TaskInput[] = []
  const skipped: string[] = []
  for (const account of accounts) {
    if (account.store !== task.store) {
      skipped.push(account.id)
      continue
    }
    inputs.push({
      store: task.store,
      sku: task.sku,
      quantity: task.quantity,
      profileId: task.profileId,
      accountId: account.id,
      proxyGroupId: account.proxyGroupId ?? null,
      monitorProxyGroupId: null,
      confirmPurchase: task.confirmPurchase,
      testMode: task.testMode === true,
      group: task.group ?? "",
      imageUrl: task.imageUrl,
      monitorOnly: task.monitorOnly === true,
      overrides: task.overrides ? { ...task.overrides } : undefined,
      kind: task.kind,
      keywords: task.keywords,
      priceCap: task.priceCap ?? null,
      webhook: task.webhook,
      activeHours: task.activeHours,
      linkedCheckoutIds: [],
      checkoutDelayMs: task.checkoutDelayMs ?? null,
      maxPrice: task.maxPrice ?? null,
      startMode: "manual",
      linkedMonitorId: null,
      jitterPct: task.jitterPct ?? null,
      rotateProxy: task.rotateProxy ?? null,
      maxRotations: task.maxRotations ?? null
    })
  }
  return { inputs, skipped }
}
