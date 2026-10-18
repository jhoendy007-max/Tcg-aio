import { AppError } from "./errors"
import type { MailLang } from "./mail"
import type { PublicTask, SoldByMode, StartMode, TaskInput, TaskKind, TaskRole } from "./types"

const START_MODES: readonly StartMode[] = ["manual", "scheduled", "monitor", "restock", "builtin"]

export function kindFrom(input: { kind?: TaskKind; monitorOnly?: boolean }, existing?: { kind?: TaskKind; monitorOnly?: boolean }): TaskKind {
  if (input.kind === "monitor" || input.kind === "checkout") return input.kind
  if (input.monitorOnly === true) return "monitor"
  if (input.monitorOnly === false) return "checkout"
  if (existing?.kind === "monitor" || existing?.monitorOnly) return "monitor"
  return "checkout"
}

export function normalizeRole(task: Partial<PublicTask> | undefined): TaskRole {
  const kind = kindFrom(task ?? {})
  const startMode = START_MODES.includes(task?.startMode as StartMode)
    ? task!.startMode!
    : kind === "monitor" ? "manual" : "builtin"
  return {
    kind,
    keywords: clip(task?.keywords, 200),
    priceCap: softMoney(task?.priceCap),
    webhook: clip(task?.webhook, 300),
    activeHours: clip(task?.activeHours, 400),
    linkedCheckoutIds: idList(task?.linkedCheckoutIds),
    checkoutDelayMs: softDelay(task?.checkoutDelayMs),
    maxPrice: softMoney(task?.maxPrice),
    startMode,
    linkedMonitorId: task?.linkedMonitorId ? String(task.linkedMonitorId).slice(0, 80) : null,
    jitterPct: softPct(task?.jitterPct)
  }
}

export function cleanRole(input: TaskInput, existing?: PublicTask): TaskRole {
  const kind = kindFrom(input, existing)
  const startRaw = input.startMode ?? existing?.startMode
  const startMode: StartMode = START_MODES.includes(startRaw as StartMode)
    ? startRaw as StartMode
    : kind === "monitor" ? "manual" : "builtin"
  const activeHours = typeof input.activeHours === "string" ? input.activeHours : existing?.activeHours ?? ""
  assertHours(activeHours)
  const webhook = typeof input.webhook === "string" ? input.webhook.trim() : existing?.webhook ?? ""
  assertTaskWebhook(webhook)
  return {
    kind,
    keywords: clip(input.keywords ?? existing?.keywords, 200),
    priceCap: input.priceCap === undefined ? moneyOrNull(existing?.priceCap) : moneyOrNull(input.priceCap),
    webhook: webhook.slice(0, 300),
    activeHours: activeHours.trim().slice(0, 400),
    linkedCheckoutIds: input.linkedCheckoutIds === undefined ? idList(existing?.linkedCheckoutIds) : idList(input.linkedCheckoutIds),
    checkoutDelayMs: input.checkoutDelayMs === undefined ? delayOrNull(existing?.checkoutDelayMs) : delayOrNull(input.checkoutDelayMs),
    maxPrice: input.maxPrice === undefined ? moneyOrNull(existing?.maxPrice) : moneyOrNull(input.maxPrice),
    startMode: kind === "monitor" && startMode !== "manual" && startMode !== "scheduled" ? "manual" : startMode,
    linkedMonitorId: input.linkedMonitorId === undefined ? existing?.linkedMonitorId ?? null : input.linkedMonitorId || null,
    jitterPct: input.jitterPct === undefined ? pctOrNull(existing?.jitterPct) : pctOrNull(input.jitterPct)
  }
}

/** Fields that can change while a task is running. Store, SKU, account, and payment consent cannot. */
export const LIVE_KEYS = ["keywords", "priceCap", "webhook", "activeHours", "linkedCheckoutIds", "checkoutDelayMs", "maxPrice", "jitterPct", "linkedMonitorId", "overrides", "group"] as const

export function structuralChange(existing: PublicTask, input: TaskInput): string | null {
  const nextKind = kindFrom(input, existing)
  const currentKind = kindFrom(existing)
  if (nextKind !== currentKind) return "Stop the task before changing its type."
  if (input.store !== existing.store) return "Stop the task before changing the store."
  if (input.sku.trim() !== existing.sku) return "Stop the task before changing the SKU."
  if ((input.profileId || "") !== (existing.profileId || "")) return "Stop the task before changing the profile."
  if ((input.accountId || "") !== (existing.accountId || "")) return "Stop the task before changing the account."
  if ((input.proxyGroupId || null) !== (existing.proxyGroupId || null)) return "Stop the task before changing the proxy group."
  if (input.monitorProxyGroupId !== undefined && (input.monitorProxyGroupId || null) !== (existing.monitorProxyGroupId || null)) {
    return "Stop the task before changing the proxy group."
  }
  if (Math.round(Number(input.quantity)) !== existing.quantity) return "Stop the task before changing the quantity."
  if (input.startMode && input.startMode !== normalizeRole(existing).startMode) return "Stop the task before changing how the task starts."
  if (input.confirmPurchase === true && !existing.confirmPurchase) return "Stop the task before allowing a real order."
  if (input.testMode === false && existing.testMode) return "Stop the task before turning test mode off."
  return null
}

export function inActiveHours(text: string, now = Date.now()): boolean {
  const windows = hourWindows(text)
  if (!windows.length) return true
  const minute = minutesInAtlantic(now)
  return windows.some((window) => covers(minute, window.start, window.end))
}

export function keywordMatch(keywords: string, title: string): boolean {
  const words = keywords.toLowerCase().split(/\s+/).map((word) => word.trim()).filter((word) => word.length > 1)
  if (!words.length) return true
  if (!title.trim()) return true
  const hay = title.toLowerCase()
  return words.every((word) => hay.includes(word))
}

export function triggerDecision(input: {
  keywords: string
  priceCap: number | null
  activeHours: string
  soldBy?: SoldByMode
  title: string
  price: number | null
  soldByRetailer: boolean
  now?: number
}): { ok: boolean; reason: string } {
  if (!inActiveHours(input.activeHours, input.now ?? Date.now())) return { ok: false, reason: "Outside this task's active hours." }
  if (!keywordMatch(input.keywords, input.title)) return { ok: false, reason: "The title does not match this monitor's keywords." }
  if (input.priceCap && input.price !== null && input.price > input.priceCap) return { ok: false, reason: "The price is above this monitor's cap." }
  if (input.soldBy === "retailer" && input.soldByRetailer === false) return { ok: false, reason: "The offer is not sold by the retailer." }
  return { ok: true, reason: "In stock." }
}

export function checkoutsToStart(monitor: Pick<PublicTask, "id" | "store" | "linkedCheckoutIds">, tasks: PublicTask[], active: (status: PublicTask["status"]) => boolean): PublicTask[] {
  const linked = new Set(monitor.linkedCheckoutIds ?? [])
  return tasks.filter((task) => {
    const role = normalizeRole(task)
    if (role.kind !== "checkout" || role.startMode !== "monitor") return false
    if (active(task.status)) return false
    return task.linkedMonitorId === monitor.id || linked.has(task.id)
  })
}

export function restockCheckouts(tasks: PublicTask[], signal: { store: PublicTask["store"]; sku: string; title?: string; price: number | null }, active: (status: PublicTask["status"]) => boolean): PublicTask[] {
  return tasks.filter((task) => {
    const role = normalizeRole(task)
    if (role.kind !== "checkout" || role.startMode !== "restock") return false
    if (active(task.status) || task.store !== signal.store) return false
    const sameSku = task.sku.trim().toLowerCase() === signal.sku.trim().toLowerCase()
    if (!sameSku) {
      if (!role.keywords.trim() || !(signal.title ?? "").trim()) return false
      if (!keywordMatch(role.keywords, signal.title ?? "")) return false
    }
    if (role.maxPrice && signal.price !== null && signal.price > role.maxPrice) return false
    return true
  })
}

const TEXT = {
  en: {
    monitor: "Monitor",
    checkout: "Checkout",
    kind: "Task type",
    store: "Store",
    sku: "SKU or URL",
    group: "Group",
    keywords: "Keywords",
    monitorDelay: "Monitor delay (ms)",
    retryDelay: "Error / retry delay (ms)",
    jitter: "Jitter (%)",
    jitterHint: "Blank uses the global jitter. A number here applies only to this task.",
    proxy: "Proxy group",
    zip: "ZIP / location",
    priceCap: "Price cap",
    soldBy: "Sold by",
    webhook: "Webhook",
    hours: "Active hours",
    links: "Linked checkout tasks",
    quantity: "Quantity",
    profile: "Profile",
    account: "Account",
    checkoutProxy: "Checkout proxy group",
    checkoutDelay: "Checkout delay (ms)",
    maxRetries: "Max retries",
    atc: "Add to cart",
    testMode: "Test mode",
    maxPrice: "Max price",
    startMode: "Start mode",
    manual: "Manual",
    scheduled: "Scheduled",
    monitorStart: "Triggered by a monitor",
    restock: "Triggered by a restock alert",
    builtin: "Built-in monitor",
    hintMonitor: "A monitor watches stock and can start the checkout tasks linked here. It does not add to cart.",
    hintCheckout: "A checkout can wait for a monitor or a restock alert, or watch the product itself.",
    inherit: "Blank uses the store setting, then the global setting.",
    live: "Delays, caps, hours, links, and the webhook can change while this task is running.",
    hoursHint: "Atlantic time. One 09:00-09:30 window per line. Blank means always.",
    retailer: "Retailer",
    anySeller: "Any seller",
    direct: "Direct connection",
    sameProxy: "Same as checkout",
    confirm: "This task may place a real shipping order and charge the saved card when the item is in stock. Ignored while test mode is on.",
    from: "From",
    healthTitle: "Store health check",
    healthHint: "Read-only monitor. No cart or checkout.",
    healthRun: "Run health check",
    healthStore: "Store",
    healthProxy: "Proxy",
    healthStatus: "Status",
    healthBlock: "Block rate",
    healthResult: "Result",
    quickTitle: "Quick setup",
    quickHint: "Pick a store, a product, one profile, and one account. This creates a monitor and a checkout that starts when the monitor sees stock. Advanced delays, hours, and webhooks stay in the full task form.",
    quickCreate: "Create monitor and checkout",
    quickAnother: "Add another account",
    quickAnotherHint: "The same monitor starts this account too.",
    quickAdvanced: "Advanced task",
    quickTest: "Test mode. The checkout runs through payment and stops before place order.",
    quickNeedProfile: "Add a shipping profile first. Open Profiles, then come back.",
    quickPickAccount: "Choose an account for this store.",
    quickNewAccount: "New account",
    quickExisting: "Saved account",
    quickLabel: "Label",
    quickEmail: "Account email",
    quickPassword: "Password",
    quickMade: "The monitor and checkout are ready. Start the monitor when you want to watch.",
    quickAdded: "Added this account to the same monitor.",
    quickWarm: "Warm the account session when the monitor starts, if it is stale.",
    quickProfiles: "Open profiles",
    inQueue: "In queue"
  },
  es: {
    monitor: "Monitor",
    checkout: "Compra",
    kind: "Tipo de tarea",
    store: "Tienda",
    sku: "SKU o URL",
    group: "Grupo",
    keywords: "Palabras clave",
    monitorDelay: "Espera del monitor (ms)",
    retryDelay: "Espera de error / reintento (ms)",
    jitter: "Variación (%)",
    jitterHint: "Vacío usa la variación global. Un número aquí vale solo para esta tarea.",
    proxy: "Grupo de proxy",
    zip: "ZIP / ubicación",
    priceCap: "Tope de precio",
    soldBy: "Vendido por",
    webhook: "Webhook",
    hours: "Horas activas",
    links: "Tareas de compra enlazadas",
    quantity: "Cantidad",
    profile: "Perfil",
    account: "Cuenta",
    checkoutProxy: "Proxy de compra",
    checkoutDelay: "Espera de compra (ms)",
    maxRetries: "Reintentos máximos",
    atc: "Añadir al carrito",
    testMode: "Modo de prueba",
    maxPrice: "Precio máximo",
    startMode: "Cómo empieza",
    manual: "Manual",
    scheduled: "Programada",
    monitorStart: "La dispara un monitor",
    restock: "La dispara una alerta de restock",
    builtin: "Monitor propio",
    hintMonitor: "Un monitor vigila el stock y puede iniciar las compras enlazadas. No añade al carrito.",
    hintCheckout: "Una compra puede esperar un monitor o una alerta, o vigilar el producto ella misma.",
    inherit: "Vacío usa el ajuste de la tienda y después el global.",
    live: "Las esperas, topes, horas, enlaces y el webhook se pueden cambiar con la tarea en marcha.",
    hoursHint: "Hora del Atlántico. Una ventana 09:00-09:30 por línea. Vacío significa siempre.",
    retailer: "La tienda",
    anySeller: "Cualquier vendedor",
    direct: "Conexión directa",
    sameProxy: "Igual que la compra",
    confirm: "Esta tarea puede hacer un pedido real y cobrar la tarjeta guardada cuando haya stock. Se ignora con el modo de prueba.",
    from: "Origen",
    healthTitle: "Salud de las tiendas",
    healthHint: "Monitor de solo lectura. Sin carrito ni compra.",
    healthRun: "Comprobar salud",
    healthStore: "Tienda",
    healthProxy: "Proxy",
    healthStatus: "Estado",
    healthBlock: "Tasa de bloqueo",
    healthResult: "Resultado",
    quickTitle: "Inicio rápido",
    quickHint: "Elige tienda, producto, un perfil y una cuenta. Esto crea un monitor y una compra que empieza cuando el monitor ve stock. Las esperas, horas y webhooks avanzados siguen en el formulario completo.",
    quickCreate: "Crear monitor y compra",
    quickAnother: "Añadir otra cuenta",
    quickAnotherHint: "El mismo monitor inicia esta cuenta también.",
    quickAdvanced: "Tarea avanzada",
    quickTest: "Modo de prueba. La compra llega al pago y se detiene antes de hacer el pedido.",
    quickNeedProfile: "Primero añade un perfil de envío. Abre Perfiles y vuelve.",
    quickPickAccount: "Elige una cuenta de esta tienda.",
    quickNewAccount: "Cuenta nueva",
    quickExisting: "Cuenta guardada",
    quickLabel: "Nombre",
    quickEmail: "Correo de la cuenta",
    quickPassword: "Contraseña",
    quickMade: "El monitor y la compra están listos. Inicia el monitor cuando quieras vigilar.",
    quickAdded: "Esta cuenta quedó en el mismo monitor.",
    quickWarm: "Calentar la sesión de la cuenta al iniciar el monitor, si está vieja.",
    quickProfiles: "Abrir perfiles",
    inQueue: "En cola"
  }
} as const

export type TaskTextKey = keyof typeof TEXT.en

export function taskText(lang: MailLang, key: TaskTextKey): string {
  return TEXT[lang][key]
}

function clip(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

function softMoney(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const amount = Math.round(Number(value) * 100) / 100
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) return null
  return amount
}

function softDelay(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const ms = Math.round(Number(value))
  if (!Number.isFinite(ms) || ms <= 0 || ms > 120000) return null
  return ms
}

function softPct(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const pct = Math.round(Number(value))
  if (!Number.isInteger(pct) || pct < 0 || pct > 40) return null
  return pct
}

function moneyOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const amount = Math.round(Number(value) * 100) / 100
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000) throw new AppError("Price must be from 0 to 100000. 0 means no cap.")
  return amount === 0 ? null : amount
}

function delayOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const ms = Math.round(Number(value))
  if (!Number.isFinite(ms) || ms < 0 || ms > 120000) throw new AppError("Delay must be from 0 to 120000 ms. 0 means the store setting.")
  return ms === 0 ? null : ms
}

function pctOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const pct = Math.round(Number(value))
  if (!Number.isInteger(pct) || pct < 0 || pct > 40) throw new AppError("Jitter must be from 0 to 40 percent.")
  return pct
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length < 80)
  return [...new Set(ids)].slice(0, 20)
}

function assertTaskWebhook(url: string): void {
  if (!url) return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AppError("Discord webhook must be a URL.")
  }
  const host = parsed.hostname.toLowerCase()
  const ok = parsed.protocol === "https:" && (host === "discord.com" || host === "discordapp.com" || host === "canary.discord.com" || host === "ptb.discord.com") && parsed.pathname.startsWith("/api/webhooks/")
  if (!ok) throw new AppError("Webhook must be an https://discord.com/api/webhooks/ URL.")
}

function assertHours(text: string): void {
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim()
    if (!line) continue
    if (!/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.test(line)) throw new AppError("Active hours use 09:00-09:30, one window per line.")
  }
  hourWindows(text)
}

function hourWindows(text: string): { start: number; end: number }[] {
  const windows: { start: number; end: number }[] = []
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim()
    if (!line) continue
    const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(line)
    if (!match) continue
    const start = Number(match[1]) * 60 + Number(match[2])
    const end = Number(match[3]) * 60 + Number(match[4])
    if (Number(match[1]) > 23 || Number(match[3]) > 23 || Number(match[2]) > 59 || Number(match[4]) > 59 || start === end) {
      throw new AppError("Active hours use 09:00-09:30, one window per line.")
    }
    windows.push({ start, end })
  }
  return windows
}

function covers(minute: number, start: number, end: number): boolean {
  if (end > start) return minute >= start && minute < end
  return minute >= start || minute < end
}

function minutesInAtlantic(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Puerto_Rico", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(now))
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0")
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0")
  return hour * 60 + minute
}
