import { AppError } from "./errors"
import type { MailLang } from "./mail"
import { isStoreId, storeName } from "./stores"
import type { AtcMode, ModuleRecord, QueueMode, Settings, SoldByMode, StoreId, TaskOverrides } from "./types"

/** Minimum gap for one store. Matches the engine floor. A saved rate limit can be longer. */
export const MODULE_RATE_FLOOR: Record<StoreId, number> = {
  target: 250,
  walmart: 400,
  bestbuy: 250,
  "pokemon-center": 400,
  amazon: 400,
  crunchyroll: 250,
  bandai: 400,
  gamestop: 400,
  "barnes-noble": 400,
  costco: 400,
  sams: 400,
  tcgplayer: 400
}

export const MODULE_FIELDS = [
  "monitorDelayMs",
  "retryDelayMs",
  "rateLimitMs",
  "endpoint",
  "zips",
  "storeIds",
  "queue",
  "atcMode",
  "soldBy",
  "sessionRefreshMin",
  "maxRetries",
  "testMode",
  "blockBackoffMs"
] as const

export type ModuleField = (typeof MODULE_FIELDS)[number]

export type SettingSource = "task" | "module" | "global" | "recommended"

export type { ModuleRecord, TaskOverrides }

export interface ResolvedField<T> {
  value: T
  source: SettingSource
}

export interface ResolvedModule {
  monitorDelayMs: ResolvedField<number>
  retryDelayMs: ResolvedField<number>
  rateLimitMs: ResolvedField<number>
  endpoint: ResolvedField<string>
  zips: ResolvedField<string>
  storeIds: ResolvedField<string>
  queue: ResolvedField<QueueMode>
  atcMode: ResolvedField<AtcMode>
  soldBy: ResolvedField<SoldByMode>
  sessionRefreshMin: ResolvedField<number>
  maxRetries: ResolvedField<number>
  testMode: ResolvedField<boolean>
  blockBackoffMs: ResolvedField<number>
}

export interface ModuleScope {
  modules?: Partial<Record<StoreId, ModuleRecord>>
  monitorDelayMs: number
  sessionWarmupMin: number
  blockRetries: number
  testMode: boolean
  monitorZips: string
  monitorStoreIds: string
  targetZip: string
  targetStoreId: string
}

export interface ModulePace {
  monitorDelayMs: number
  retryDelayMs: number
  rateLimitMs: number
  endpoint: string
  zips: string
  storeIds: string
  queue: QueueMode
  atcMode: AtcMode
  soldBy: SoldByMode
  sessionRefreshMin: number
  maxRetries: number
  testMode: boolean
  blockBackoffMs: number
}

const RECOMMENDED: Record<StoreId, ModulePace> = {
  target: { monitorDelayMs: 2000, retryDelayMs: 4000, rateLimitMs: 250, endpoint: "redsky", zips: "", storeIds: "", queue: "wait", atcMode: "fast", soldBy: "retailer", sessionRefreshMin: 45, maxRetries: 4, testMode: false, blockBackoffMs: 2000 },
  walmart: { monitorDelayMs: 4000, retryDelayMs: 8000, rateLimitMs: 400, endpoint: "item", zips: "", storeIds: "", queue: "wait", atcMode: "standard", soldBy: "retailer", sessionRefreshMin: 20, maxRetries: 3, testMode: false, blockBackoffMs: 8000 },
  bestbuy: { monitorDelayMs: 2500, retryDelayMs: 5000, rateLimitMs: 250, endpoint: "product", zips: "", storeIds: "", queue: "wait", atcMode: "fast", soldBy: "retailer", sessionRefreshMin: 30, maxRetries: 3, testMode: false, blockBackoffMs: 4000 },
  "pokemon-center": { monitorDelayMs: 5000, retryDelayMs: 8000, rateLimitMs: 400, endpoint: "product", zips: "", storeIds: "", queue: "wait", atcMode: "standard", soldBy: "retailer", sessionRefreshMin: 30, maxRetries: 2, testMode: false, blockBackoffMs: 8000 },
  amazon: { monitorDelayMs: 3500, retryDelayMs: 6000, rateLimitMs: 400, endpoint: "offers", zips: "", storeIds: "", queue: "wait", atcMode: "fast", soldBy: "retailer", sessionRefreshMin: 20, maxRetries: 3, testMode: false, blockBackoffMs: 6000 },
  crunchyroll: { monitorDelayMs: 2500, retryDelayMs: 5000, rateLimitMs: 250, endpoint: "product", zips: "", storeIds: "", queue: "wait", atcMode: "fast", soldBy: "retailer", sessionRefreshMin: 40, maxRetries: 3, testMode: false, blockBackoffMs: 4000 },
  bandai: { monitorDelayMs: 4000, retryDelayMs: 8000, rateLimitMs: 400, endpoint: "product-api", zips: "", storeIds: "", queue: "wait", atcMode: "standard", soldBy: "retailer", sessionRefreshMin: 30, maxRetries: 3, testMode: false, blockBackoffMs: 8000 },
  gamestop: { monitorDelayMs: 4000, retryDelayMs: 8000, rateLimitMs: 400, endpoint: "page", zips: "", storeIds: "", queue: "wait", atcMode: "standard", soldBy: "retailer", sessionRefreshMin: 30, maxRetries: 3, testMode: false, blockBackoffMs: 8000 },
  "barnes-noble": { monitorDelayMs: 4000, retryDelayMs: 8000, rateLimitMs: 400, endpoint: "page", zips: "", storeIds: "", queue: "wait", atcMode: "standard", soldBy: "retailer", sessionRefreshMin: 30, maxRetries: 3, testMode: false, blockBackoffMs: 8000 },
  costco: { monitorDelayMs: 4000, retryDelayMs: 8000, rateLimitMs: 400, endpoint: "page", zips: "", storeIds: "", queue: "wait", atcMode: "standard", soldBy: "retailer", sessionRefreshMin: 30, maxRetries: 3, testMode: false, blockBackoffMs: 8000 },
  sams: { monitorDelayMs: 4000, retryDelayMs: 8000, rateLimitMs: 400, endpoint: "page", zips: "", storeIds: "", queue: "wait", atcMode: "standard", soldBy: "retailer", sessionRefreshMin: 30, maxRetries: 3, testMode: false, blockBackoffMs: 8000 },
  tcgplayer: { monitorDelayMs: 3000, retryDelayMs: 6000, rateLimitMs: 400, endpoint: "catalog", zips: "", storeIds: "", queue: "wait", atcMode: "standard", soldBy: "retailer", sessionRefreshMin: 30, maxRetries: 3, testMode: false, blockBackoffMs: 6000 }
}

export const MODULE_ENDPOINTS: Record<StoreId, readonly string[]> = {
  target: ["redsky"],
  walmart: ["item"],
  bestbuy: ["product"],
  "pokemon-center": ["product"],
  amazon: ["offers", "page"],
  crunchyroll: ["product"],
  bandai: ["product-api"],
  gamestop: ["page"],
  "barnes-noble": ["page"],
  costco: ["page"],
  sams: ["page"],
  tcgplayer: ["catalog"]
}

const GLOBAL_FIELDS = new Set<ModuleField>([
  "monitorDelayMs",
  "retryDelayMs",
  "rateLimitMs",
  "zips",
  "storeIds",
  "sessionRefreshMin",
  "maxRetries",
  "testMode",
  "blockBackoffMs"
])

export function moduleUsesGlobal(field: ModuleField): field is NonNullable<ModuleRecord["useGlobal"]>[number] {
  return GLOBAL_FIELDS.has(field)
}

export function recommendedModule(store: StoreId): ModulePace {
  return { ...RECOMMENDED[store] }
}

export function moduleScope(settings: Settings): ModuleScope {
  return {
    modules: settings.modules,
    monitorDelayMs: settings.monitorDelayMs,
    sessionWarmupMin: settings.sessionWarmupMin,
    blockRetries: settings.blockRetries,
    testMode: settings.testMode,
    monitorZips: settings.monitorZips,
    monitorStoreIds: settings.monitorStoreIds,
    targetZip: settings.targetZip,
    targetStoreId: settings.targetStoreId
  }
}

export function resolveModule(store: StoreId, scope: ModuleScope, task?: TaskOverrides | null): ResolvedModule {
  const saved = scope.modules?.[store] ?? {}
  const useGlobal = new Set(saved.useGlobal ?? [])
  const base = RECOMMENDED[store]
  return {
    monitorDelayMs: pickNumber("monitorDelayMs", saved, useGlobal, task, scope, base.monitorDelayMs, scope.monitorDelayMs),
    retryDelayMs: pickNumber("retryDelayMs", saved, useGlobal, task, scope, base.retryDelayMs, scope.monitorDelayMs),
    rateLimitMs: clampRate(store, pickNumber("rateLimitMs", saved, useGlobal, task, scope, base.rateLimitMs, MODULE_RATE_FLOOR[store])),
    endpoint: pickString("endpoint", saved, task, base.endpoint),
    zips: pickString("zips", saved, task, base.zips, useGlobal.has("zips") ? globalPlace(store, scope, "zips") : undefined),
    storeIds: pickString("storeIds", saved, task, base.storeIds, useGlobal.has("storeIds") ? globalPlace(store, scope, "storeIds") : undefined),
    queue: pickEnum("queue", saved, task, base.queue, ["wait", "skip", "pause"]),
    atcMode: pickEnum("atcMode", saved, task, base.atcMode, ["fast", "standard"]),
    soldBy: pickEnum("soldBy", saved, task, base.soldBy, ["retailer", "any"]),
    sessionRefreshMin: pickNumber("sessionRefreshMin", saved, useGlobal, task, scope, base.sessionRefreshMin, scope.sessionWarmupMin),
    maxRetries: pickNumber("maxRetries", saved, useGlobal, task, scope, base.maxRetries, scope.blockRetries),
    testMode: pickTest(saved, useGlobal, task, scope, base.testMode),
    blockBackoffMs: pickNumber("blockBackoffMs", saved, useGlobal, task, scope, base.blockBackoffMs, scope.monitorDelayMs)
  }
}

/** Concrete numbers the runner and the store modules read. */
export function resolvedValues(resolved: ResolvedModule): ModulePace {
  return {
    monitorDelayMs: resolved.monitorDelayMs.value,
    retryDelayMs: resolved.retryDelayMs.value,
    rateLimitMs: resolved.rateLimitMs.value,
    endpoint: resolved.endpoint.value,
    zips: resolved.zips.value,
    storeIds: resolved.storeIds.value,
    queue: resolved.queue.value,
    atcMode: resolved.atcMode.value,
    soldBy: resolved.soldBy.value,
    sessionRefreshMin: resolved.sessionRefreshMin.value,
    maxRetries: resolved.maxRetries.value,
    testMode: resolved.testMode.value,
    blockBackoffMs: resolved.blockBackoffMs.value
  }
}

export function cleanModuleRecord(store: StoreId, input: unknown): ModuleRecord {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError("Store settings are invalid.")
  const raw = input as Record<string, unknown>
  const record: ModuleRecord = {}
  if (raw.monitorDelayMs !== undefined) record.monitorDelayMs = cleanDelay(raw.monitorDelayMs, MODULE_RATE_FLOOR[store], "Monitor delay")
  if (raw.retryDelayMs !== undefined) record.retryDelayMs = cleanDelay(raw.retryDelayMs, 250, "Retry delay")
  if (raw.rateLimitMs !== undefined) record.rateLimitMs = cleanDelay(raw.rateLimitMs, MODULE_RATE_FLOOR[store], "Rate limit")
  if (raw.endpoint !== undefined) record.endpoint = cleanEndpoint(store, raw.endpoint)
  if (raw.zips !== undefined) record.zips = cleanZips(raw.zips)
  if (raw.storeIds !== undefined) record.storeIds = cleanStoreIds(raw.storeIds)
  if (raw.queue !== undefined) record.queue = cleanEnum(raw.queue, ["wait", "skip", "pause"] as const, "Queue")
  if (raw.atcMode !== undefined) record.atcMode = cleanEnum(raw.atcMode, ["fast", "standard"] as const, "Add to cart")
  if (raw.soldBy !== undefined) record.soldBy = cleanEnum(raw.soldBy, ["retailer", "any"] as const, "Sold by")
  if (raw.sessionRefreshMin !== undefined) record.sessionRefreshMin = cleanInt(raw.sessionRefreshMin, 5, 240, "Session refresh")
  if (raw.maxRetries !== undefined) record.maxRetries = cleanInt(raw.maxRetries, 1, 8, "Max retries")
  if (raw.testMode !== undefined) record.testMode = raw.testMode === true
  if (raw.blockBackoffMs !== undefined) record.blockBackoffMs = cleanDelay(raw.blockBackoffMs, 250, "Block backoff")
  const useGlobal = Array.isArray(raw.useGlobal) ? raw.useGlobal.filter((field): field is NonNullable<ModuleRecord["useGlobal"]>[number] => typeof field === "string" && GLOBAL_FIELDS.has(field as ModuleField)) : []
  if (useGlobal.length) record.useGlobal = [...new Set(useGlobal)]
  return record
}

export function cleanTaskOverrides(store: StoreId, input: unknown): TaskOverrides | undefined {
  if (input === undefined || input === null) return undefined
  const record = cleanModuleRecord(store, input)
  delete record.useGlobal
  return Object.keys(record).length ? record : undefined
}

export function cleanModules(input: Settings["modules"] | undefined): Partial<Record<StoreId, ModuleRecord>> {
  const source = input ?? {}
  const next: Partial<Record<StoreId, ModuleRecord>> = {}
  for (const [store, record] of Object.entries(source)) {
    if (!isStoreId(store)) throw new AppError("That store is not in TCGAIO.")
    if (record) next[store] = cleanModuleRecord(store, record)
  }
  return next
}

export function exportModulePreset(store: StoreId, scope: ModuleScope): string {
  const saved = scope.modules?.[store] ?? {}
  return JSON.stringify({ v: 1, store, name: storeName(store), ...saved }, null, 2)
}

export function parseModulePreset(text: string): { store: StoreId; record: ModuleRecord } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AppError("That preset is not valid JSON.")
  }
  if (!parsed || typeof parsed !== "object") throw new AppError("That preset is not a store settings file.")
  const body = parsed as Record<string, unknown>
  if (body.v !== 1) throw new AppError("That preset is from a different TCGAIO version.")
  if (typeof body.store !== "string" || !isStoreId(body.store)) throw new AppError("That preset names a store TCGAIO does not have.")
  const { v: _v, store: _store, name: _name, ...rest } = body
  return { store: body.store, record: cleanModuleRecord(body.store, rest) }
}

const TEXT = {
  en: {
    nav: "Stores",
    title: "Store settings",
    intro: "Each store has its own defaults. A task override wins, then this page, then the global Settings values. Reset restores the recommended numbers for this store.",
    reset: "Reset to recommended",
    save: "Save store",
    saved: "Store settings saved.",
    resetDone: "Recommended defaults restored.",
    imported: "Preset imported.",
    export: "Export preset",
    import: "Import preset",
    importAction: "Import",
    useGlobal: "Use the global value",
    from: "From",
    task: "This task",
    module: "This store",
    global: "Global",
    recommended: "Recommended",
    monitorDelayMs: "Monitor delay (ms)",
    retryDelayMs: "Retry delay (ms)",
    rateLimitMs: "Rate limit (ms)",
    endpoint: "Preferred endpoint",
    zips: "ZIP codes",
    storeIds: "Store IDs",
    queue: "Queue",
    atcMode: "Add to cart",
    soldBy: "Sold by",
    sessionRefreshMin: "Session refresh (minutes)",
    maxRetries: "Max retries",
    testMode: "Test mode default",
    blockBackoffMs: "Block backoff (ms)",
    wait: "Wait in line",
    skip: "Skip the queue",
    pause: "Pause the task",
    fast: "Fast",
    standard: "Standard",
    retailer: "The retailer",
    any: "Any seller",
    on: "On",
    off: "Off",
    overrides: "Task overrides",
    overrideHint: "Leave a field blank to use the store setting.",
    testForced: "Global test mode is on, so this store still runs as a test.",
    rateFloor: "The app will not go faster than this store's minimum gap.",
    phoneTitle: "Stores",
    phoneBack: "Back"
  },
  es: {
    nav: "Tiendas",
    title: "Ajustes de la tienda",
    intro: "Cada tienda tiene sus propios valores. Una tarea gana, luego esta página, y después los ajustes globales. Restablecer vuelve a los números recomendados de esta tienda.",
    reset: "Volver a lo recomendado",
    save: "Guardar tienda",
    saved: "Ajustes de la tienda guardados.",
    resetDone: "Valores recomendados restaurados.",
    imported: "Ajuste importado.",
    export: "Exportar ajuste",
    import: "Importar ajuste",
    importAction: "Importar",
    useGlobal: "Usar el valor global",
    from: "Origen",
    task: "Esta tarea",
    module: "Esta tienda",
    global: "Global",
    recommended: "Recomendado",
    monitorDelayMs: "Espera del monitor (ms)",
    retryDelayMs: "Espera de reintento (ms)",
    rateLimitMs: "Límite de ritmo (ms)",
    endpoint: "Endpoint preferido",
    zips: "Códigos ZIP",
    storeIds: "IDs de tienda",
    queue: "Cola",
    atcMode: "Añadir al carrito",
    soldBy: "Vendido por",
    sessionRefreshMin: "Renovación de sesión (minutos)",
    maxRetries: "Reintentos máximos",
    testMode: "Modo de prueba por defecto",
    blockBackoffMs: "Espera tras un bloqueo (ms)",
    wait: "Esperar en la cola",
    skip: "Saltar la cola",
    pause: "Pausar la tarea",
    fast: "Rápido",
    standard: "Normal",
    retailer: "La tienda",
    any: "Cualquier vendedor",
    on: "Activo",
    off: "Inactivo",
    overrides: "Ajustes de esta tarea",
    overrideHint: "Deja un campo vacío para usar el ajuste de la tienda.",
    testForced: "El modo de prueba global está activo, así que esta tienda sigue en prueba.",
    rateFloor: "La app no irá más rápido que el mínimo de esta tienda.",
    phoneTitle: "Tiendas",
    phoneBack: "Volver"
  }
} as const

export type ModuleTextKey = keyof typeof TEXT.en

export function moduleText(lang: MailLang, key: ModuleTextKey): string {
  return TEXT[lang][key]
}

export function sourceLabel(lang: MailLang, source: SettingSource): string {
  if (source === "task") return moduleText(lang, "task")
  if (source === "module") return moduleText(lang, "module")
  if (source === "global") return moduleText(lang, "global")
  return moduleText(lang, "recommended")
}

function pickNumber(
  field: ModuleField,
  saved: ModuleRecord,
  useGlobal: Set<ModuleField>,
  task: TaskOverrides | null | undefined,
  _scope: ModuleScope,
  recommended: number,
  globalValue: number
): ResolvedField<number> {
  const fromTask = task?.[field as keyof TaskOverrides]
  if (typeof fromTask === "number") return { value: fromTask, source: "task" }
  if (useGlobal.has(field)) return { value: globalValue, source: "global" }
  const fromModule = saved[field as keyof ModuleRecord]
  if (typeof fromModule === "number") return { value: fromModule, source: "module" }
  return { value: recommended, source: "recommended" }
}

function pickString(
  field: "endpoint" | "zips" | "storeIds",
  saved: ModuleRecord,
  task: TaskOverrides | null | undefined,
  recommended: string,
  globalValue?: string
): ResolvedField<string> {
  const fromTask = task?.[field]
  if (typeof fromTask === "string") return { value: fromTask, source: "task" }
  if (globalValue !== undefined) return { value: globalValue, source: "global" }
  const fromModule = saved[field]
  if (typeof fromModule === "string") return { value: fromModule, source: "module" }
  return { value: recommended, source: "recommended" }
}

function pickEnum<T extends string>(
  field: "queue" | "atcMode" | "soldBy",
  saved: ModuleRecord,
  task: TaskOverrides | null | undefined,
  recommended: T,
  allowed: readonly T[]
): ResolvedField<T> {
  const fromTask = task?.[field]
  if (typeof fromTask === "string" && allowed.includes(fromTask as T)) return { value: fromTask as T, source: "task" }
  const fromModule = saved[field]
  if (typeof fromModule === "string" && allowed.includes(fromModule as T)) return { value: fromModule as T, source: "module" }
  return { value: recommended, source: "recommended" }
}

function pickTest(saved: ModuleRecord, useGlobal: Set<ModuleField>, task: TaskOverrides | null | undefined, scope: ModuleScope, recommended: boolean): ResolvedField<boolean> {
  if (scope.testMode) return { value: true, source: "global" }
  if (typeof task?.testMode === "boolean") return { value: task.testMode, source: "task" }
  if (useGlobal.has("testMode")) return { value: scope.testMode, source: "global" }
  if (typeof saved.testMode === "boolean") return { value: saved.testMode, source: "module" }
  return { value: recommended, source: "recommended" }
}

function clampRate(store: StoreId, field: ResolvedField<number>): ResolvedField<number> {
  const floor = MODULE_RATE_FLOOR[store]
  if (field.value >= floor) return field
  return { value: floor, source: field.source }
}

function globalPlace(store: StoreId, scope: ModuleScope, field: "zips" | "storeIds"): string {
  if (store === "target") return field === "zips" ? scope.targetZip : scope.targetStoreId
  return field === "zips" ? scope.monitorZips : scope.monitorStoreIds
}

function cleanDelay(value: unknown, min: number, label: string): number {
  const ms = Math.round(Number(value))
  if (!Number.isFinite(ms) || ms < min || ms > 120_000) throw new AppError(`${label} must be from ${min} to 120000 ms.`)
  return ms
}

function cleanInt(value: unknown, min: number, max: number, label: string): number {
  const n = Math.round(Number(value))
  if (!Number.isInteger(n) || n < min || n > max) throw new AppError(`${label} must be from ${min} to ${max}.`)
  return n
}

function cleanEndpoint(store: StoreId, value: unknown): string {
  const endpoint = typeof value === "string" ? value.trim() : ""
  if (!MODULE_ENDPOINTS[store].includes(endpoint)) throw new AppError("Choose an endpoint this store already uses.")
  return endpoint
}

function cleanZips(value: unknown): string {
  const text = typeof value === "string" ? value : ""
  const zips = text.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)
  for (const zip of zips) {
    if (!/^\d{5}(?:-\d{4})?$/.test(zip)) throw new AppError("ZIP codes must be 5-digit US ZIPs.")
  }
  return zips.join(", ")
}

function cleanStoreIds(value: unknown): string {
  const text = typeof value === "string" ? value : ""
  const ids = text.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean)
  for (const id of ids) {
    if (!/^\d{3,6}$/.test(id)) throw new AppError("Store IDs must be numbers.")
  }
  return ids.join(", ")
}

function cleanEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value === "string" && allowed.includes(value as T)) return value as T
  throw new AppError(`${label} is not one of the choices.`)
}
