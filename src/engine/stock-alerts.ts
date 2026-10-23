import type { Notice, Settings } from "../shared/types"

/**
 * Remembers the last stock reading per item so Discord only hears about a change:
 * out/unknown -> in sends "instock" (once per cooldown), in -> out sends "oos".
 */
export class StockAlerts {
  private readonly state = new Map<string, { stock: "in" | "out"; lastInAlert: number }>()

  constructor(private readonly cooldownMs: () => number) {}

  read(key: string, inStock: boolean, now = Date.now()): "instock" | "oos" | null {
    const prev = this.state.get(key)
    const stock = inStock ? "in" : "out"
    if (!prev) {
      this.state.set(key, { stock, lastInAlert: inStock ? now : 0 })
      return inStock ? "instock" : null
    }
    if (prev.stock === stock) return null
    prev.stock = stock
    if (!inStock) return "oos"
    if (prev.lastInAlert && now - prev.lastInAlert < this.cooldownMs()) return null
    prev.lastInAlert = now
    return "instock"
  }

  forget(key: string): void {
    this.state.delete(key)
  }
}

export function stockKey(store: string, sku: string): string {
  return `${store}:${sku.trim().toLowerCase()}`
}

/** Settings > Notifications decides which kinds reach Discord. Missing fields use the defaults. */
export function noticeAllowed(settings: Partial<Settings>, notice: Pick<Notice, "kind">): boolean {
  switch (notice.kind) {
    case "instock": return settings.notifyInStock !== false
    case "oos": return settings.notifyOutOfStock === true
    case "success": return settings.notifySuccess !== false
    case "tested": return settings.notifyDryRun !== false
    case "failure": return settings.notifyFailed !== false
    case "blocked": return settings.notifyBlocked === true
    case "challenge": return settings.notifyChallenge !== false
    default: return true
  }
}

/** Moves the first per-task webhook into the global setting when the global one is empty. */
export function migrateTaskWebhook(settings: Settings, tasks: Array<{ webhook?: string }>): Settings | null {
  if (settings.discordWebhook?.trim()) return null
  const found = tasks.map((task) => (task.webhook ?? "").trim()).find(Boolean)
  return found ? { ...settings, discordWebhook: found } : null
}
