import { recommendedModule } from "./module-settings"
import type { QueueMode, StoreId, TaskOverrides } from "./types"
import { isStoreId } from "./stores"

export type TaskRoleName = "monitor" | "checkout"
export type DefaultSource = "task" | "store" | "builtin"

export interface RoleDefaults {
  monitorDelayMs: number
  retryDelayMs: number
  blockBackoffMs: number
  queue: QueueMode
  quantity: number
  maxPrice: number | null
  warmOnStart: boolean
  addressOrderLimit: number
  checkoutDelayMs: number
  testMode: boolean
}

export type RolePatch = Partial<RoleDefaults>
export type StoreRoles = Partial<Record<StoreId, { monitor?: RolePatch; checkout?: RolePatch }>>

const FIELDS = [
  "monitorDelayMs",
  "retryDelayMs",
  "blockBackoffMs",
  "queue",
  "quantity",
  "maxPrice",
  "warmOnStart",
  "addressOrderLimit",
  "checkoutDelayMs",
  "testMode"
] as const

export type RoleField = (typeof FIELDS)[number]

/** Built-in numbers come from each store's recommended pace, plus a safe checkout shape. */
export function builtinRole(store: StoreId, role: TaskRoleName): RoleDefaults {
  const pace = recommendedModule(store)
  return {
    monitorDelayMs: pace.monitorDelayMs,
    retryDelayMs: pace.retryDelayMs,
    blockBackoffMs: pace.blockBackoffMs,
    queue: pace.queue,
    quantity: 1,
    maxPrice: null,
    warmOnStart: role === "checkout",
    addressOrderLimit: 3,
    checkoutDelayMs: 0,
    testMode: false
  }
}

export function resolveRoleDefaults(
  store: StoreId,
  role: TaskRoleName,
  saved: StoreRoles | undefined,
  task?: RolePatch | null
): { [K in RoleField]: { value: RoleDefaults[K]; source: DefaultSource } } {
  const builtin = builtinRole(store, role)
  const storePatch = saved?.[store]?.[role] ?? {}
  const taskPatch = task ?? {}
  const out = {} as { [K in RoleField]: { value: RoleDefaults[K]; source: DefaultSource } }
  for (const field of FIELDS) {
    const taskValue = taskPatch[field]
    const storeValue = storePatch[field]
    const chosen = field === "warmOnStart" && role === "monitor"
      ? { value: false as RoleDefaults[typeof field], source: "builtin" as const }
      : taskValue !== undefined
        ? { value: taskValue, source: "task" as const }
        : storeValue !== undefined
          ? { value: storeValue, source: "store" as const }
          : { value: builtin[field], source: "builtin" as const }
    Object.assign(out, { [field]: chosen })
  }
  return out
}

export function prefillRole(store: StoreId, role: TaskRoleName, saved: StoreRoles | undefined): RoleDefaults {
  const resolved = resolveRoleDefaults(store, role, saved)
  return {
    monitorDelayMs: resolved.monitorDelayMs.value,
    retryDelayMs: resolved.retryDelayMs.value,
    blockBackoffMs: resolved.blockBackoffMs.value,
    queue: resolved.queue.value,
    quantity: resolved.quantity.value,
    maxPrice: resolved.maxPrice.value,
    warmOnStart: resolved.warmOnStart.value,
    addressOrderLimit: resolved.addressOrderLimit.value,
    checkoutDelayMs: resolved.checkoutDelayMs.value,
    testMode: resolved.testMode.value
  }
}

/** A saved task wins. A blank field picks up the user's store default so the runner matches the form. */
export function overridesWithStoreRole(
  store: StoreId,
  role: TaskRoleName,
  saved: StoreRoles | undefined,
  overrides: TaskOverrides | undefined
): TaskOverrides | undefined {
  const resolved = resolveRoleDefaults(store, role, saved)
  const next: TaskOverrides = { ...overrides }
  if (next.monitorDelayMs == null && resolved.monitorDelayMs.source === "store") next.monitorDelayMs = resolved.monitorDelayMs.value
  if (next.retryDelayMs == null && resolved.retryDelayMs.source === "store") next.retryDelayMs = resolved.retryDelayMs.value
  if (next.blockBackoffMs == null && resolved.blockBackoffMs.source === "store") next.blockBackoffMs = resolved.blockBackoffMs.value
  if (next.queue == null && resolved.queue.source === "store") next.queue = resolved.queue.value
  return Object.keys(next).length ? next : undefined
}

export function fieldMark(value: unknown, fallback: unknown): "default" | "custom" {
  return value === fallback || (value == null && fallback == null) ? "default" : "custom"
}

export function cleanStoreRoles(input: unknown): StoreRoles {
  if (input == null) return {}
  if (typeof input !== "object" || Array.isArray(input)) return {}
  const next: StoreRoles = {}
  for (const [store, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isStoreId(store) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const row = raw as { monitor?: unknown; checkout?: unknown }
    const monitor = cleanPatch(row.monitor)
    if (monitor) monitor.warmOnStart = false
    const checkout = cleanPatch(row.checkout)
    if (monitor || checkout) next[store] = { ...(monitor ? { monitor } : {}), ...(checkout ? { checkout } : {}) }
  }
  return next
}

function cleanPatch(input: unknown): RolePatch | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined
  const raw = input as Record<string, unknown>
  const patch: RolePatch = {}
  if (raw.monitorDelayMs !== undefined) patch.monitorDelayMs = clamp(raw.monitorDelayMs, 250, 120000)
  if (raw.retryDelayMs !== undefined) patch.retryDelayMs = clamp(raw.retryDelayMs, 250, 120000)
  if (raw.blockBackoffMs !== undefined) patch.blockBackoffMs = clamp(raw.blockBackoffMs, 250, 120000)
  if (raw.queue === "wait" || raw.queue === "skip" || raw.queue === "pause") patch.queue = raw.queue
  if (raw.quantity !== undefined) patch.quantity = clamp(raw.quantity, 1, 12)
  if (raw.maxPrice === null) patch.maxPrice = null
  else if (raw.maxPrice !== undefined) patch.maxPrice = Math.max(0, Math.round(Number(raw.maxPrice) * 100) / 100)
  if (typeof raw.warmOnStart === "boolean") patch.warmOnStart = raw.warmOnStart
  if (raw.addressOrderLimit !== undefined) patch.addressOrderLimit = clamp(raw.addressOrderLimit, 1, 99)
  if (raw.checkoutDelayMs !== undefined) patch.checkoutDelayMs = clamp(raw.checkoutDelayMs, 0, 120000)
  if (typeof raw.testMode === "boolean") patch.testMode = raw.testMode
  return Object.keys(patch).length ? patch : undefined
}

function clamp(value: unknown, min: number, max: number): number {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, number))
}
