import type { StoreId } from "./types"

/** Hidden Chromium windows that may load at once. The rest wait in a queue. */
export const DEFAULT_WINDOW_CAP = 3
/** Light browse starts this many days before a scheduled drop. */
export const WARM_DAYS = 2
/** Gap between one account's browse and the next. */
export const HUMAN_GAP_MS = 45_000
/** Near-expiry refreshes are spread across this window before the drop. */
export const STAGGER_MS = 3 * 60 * 1000

export type SessionFreshness = "missing" | "expired" | "fresh" | "due" | "stale"
export type BindingSource = "account" | "task" | "direct" | "none"
export type BindingWarning = "sticky" | "monitor"

export interface FreshAccount {
  id: string
  store: StoreId
  hasSession: boolean
  sessionState: "missing" | "saved" | "expired"
  lastWarmAt: number | null
}

export interface WarmStep {
  accountId: string
  store: StoreId
  at: number
  /** A store homepage or a sign-in check. Never a cart or checkout URL. */
  kind: "browse" | "signin-check"
}

export interface RefreshSlot {
  accountId: string
  at: number
}

const TEXT = {
  en: {
    profile: "Browser profile",
    stickyProxy: "Sticky proxy",
    freshness: "Session",
    fresh: "Fresh",
    due: "Due soon",
    stale: "Needs a refresh",
    expired: "Sign in again",
    missing: "No session",
    fromAccount: "From the account",
    fromTask: "From this task",
    fromDirect: "Direct connection",
    fromNone: "No account",
    stickyWarning: "This task's proxy group does not change the account's sticky proxy.",
    monitorWarning: "Monitor checks for this account use the same sticky proxy. The monitor pool is not used.",
    effective: "Effective binding",
    accountsIntro: "Each account keeps its own Chromium profile and one sticky proxy. Tasks for that account reuse both. Session Sync cookies already saved for the account are written into that profile.",
    stickyHint: "One proxy for this account. It is not shared with other accounts, and it does not change in the middle of a checkout.",
    proxyIntro: "A proxy is quarantined after three HTTP 403, 412, or 435 responses, then left alone for 30 minutes. HTTP 429 does not quarantine it. Each account keeps its own proxy.",
    residentialNote: "Use a residential proxy you control. Datacenter addresses are challenged more often. TCGAIO does not hide the browser's TLS handshake or change the device fingerprint.",
    health: "Health",
    quarantined: "Quarantined until",
    noSamples: "No samples yet",
    windowCap: "Hidden session windows",
    windowCapHint: "How many hidden session refreshes can load at once. 1–10. The rest wait. Default 3.",
    warmupNote: "Optional warm-up opens the store homepage and checks the sign-in in the days before a drop. It does not add to cart. Near-expiry sessions refresh a few minutes before the drop, spread out so the browsers do not all open at once."
  },
  es: {
    profile: "Perfil del navegador",
    stickyProxy: "Proxy fijo",
    freshness: "Sesión",
    fresh: "Reciente",
    due: "Pronto vence",
    stale: "Necesita refresco",
    expired: "Inicia sesión otra vez",
    missing: "Sin sesión",
    fromAccount: "De la cuenta",
    fromTask: "De esta tarea",
    fromDirect: "Conexión directa",
    fromNone: "Sin cuenta",
    stickyWarning: "El grupo de proxy de esta tarea no cambia el proxy fijo de la cuenta.",
    monitorWarning: "Las comprobaciones de esta cuenta usan el mismo proxy fijo. El grupo del monitor no se usa.",
    effective: "Enlace efectivo",
    accountsIntro: "Cada cuenta conserva su perfil de Chromium y un proxy fijo. Las tareas de esa cuenta reutilizan ambos. Las cookies de Session Sync ya guardadas se escriben en ese perfil.",
    stickyHint: "Un proxy para esta cuenta. No se comparte con otras cuentas y no cambia a mitad de una compra.",
    proxyIntro: "Un proxy queda en cuarentena tras tres respuestas HTTP 403, 412 o 435, y descansa 30 minutos. HTTP 429 no lo pone en cuarentena. Cada cuenta conserva el suyo.",
    residentialNote: "Usa un proxy residencial que controles. Las direcciones de centro de datos reciben más desafíos. TCGAIO no oculta el TLS del navegador ni cambia la huella del dispositivo.",
    health: "Salud",
    quarantined: "En cuarentena hasta",
    noSamples: "Sin muestras",
    windowCap: "Ventanas de sesión ocultas",
    windowCapHint: "Cuántos refrescos ocultos pueden cargar a la vez. 1–10. El resto espera. El valor inicial es 3.",
    warmupNote: "El calentamiento opcional abre la página de la tienda y comprueba el inicio de sesión los días antes de un drop. No añade al carrito. Las sesiones por vencer se refrescan unos minutos antes, espaciadas para que los navegadores no se abran todos a la vez."
  }
} as const

export type ConsistencyTextKey = keyof typeof TEXT.en

export function consistencyText(lang: "en" | "es", key: ConsistencyTextKey): string {
  return TEXT[lang][key]
}

export function accountPartition(accountId: string): string {
  return `persist:account-${accountId}`
}

/** 0–100 from successful samples over successful plus quarantining samples. */
export function healthScore(score: { ok: number; blocks: number } | undefined): number {
  if (!score) return 100
  const total = score.ok + score.blocks
  if (total <= 0) return 100
  return Math.round((score.ok / total) * 100)
}

export function sessionFreshness(account: Pick<FreshAccount, "hasSession" | "sessionState" | "lastWarmAt">, now: number, freshMin: number): SessionFreshness {
  if (!account.hasSession || account.sessionState === "missing") return "missing"
  if (account.sessionState === "expired") return "expired"
  if (!account.lastWarmAt) return "stale"
  const freshMs = Math.max(1, freshMin) * 60_000
  const age = now - account.lastWarmAt
  if (age <= freshMs) return "fresh"
  if (age <= freshMs * 2) return "due"
  return "stale"
}

export function nearExpiry(account: FreshAccount, now: number, freshMin: number): boolean {
  const state = sessionFreshness(account, now, freshMin)
  return state === "due" || state === "stale" || state === "expired"
}

/**
 * Optional light browse in the days before a drop.
 * Each step is a homepage visit or a sign-in check. Nothing here adds to cart.
 */
export function planWarmup(accounts: FreshAccount[], dropAt: number, now: number, enabled: boolean, days = WARM_DAYS, gapMs = HUMAN_GAP_MS): WarmStep[] {
  if (!enabled) return []
  const open = dropAt - days * 86_400_000
  if (now >= dropAt || now < open) return []
  const steps: WarmStep[] = []
  accounts.filter((account) => account.hasSession).forEach((account, index) => {
    const at = open + index * gapMs
    steps.push({ accountId: account.id, store: account.store, at, kind: index % 2 === 0 ? "browse" : "signin-check" })
  })
  return steps
}

export function dueWarmups(accounts: FreshAccount[], dropAt: number, now: number, enabled: boolean, days = WARM_DAYS, gapMs = HUMAN_GAP_MS): WarmStep[] {
  const open = dropAt - days * 86_400_000
  return planWarmup(accounts, dropAt, now, enabled, days, gapMs).filter((step) => {
    if (step.at > now) return false
    const account = accounts.find((item) => item.id === step.accountId)
    return !account?.lastWarmAt || account.lastWarmAt < open
  })
}

/** Spread near-expiry accounts across the last few minutes before a drop. */
export function staggerPlan(accounts: FreshAccount[], dropAt: number, now: number, freshMin: number, spanMs = STAGGER_MS): RefreshSlot[] {
  if (now >= dropAt) return []
  const near = accounts.filter((account) => nearExpiry(account, now, freshMin))
  if (!near.length) return []
  const start = dropAt - spanMs
  const end = dropAt - 15_000
  const span = Math.max(0, end - start)
  return near.map((account, index) => ({
    accountId: account.id,
    at: near.length === 1 ? start : start + Math.round((span * index) / (near.length - 1))
  }))
}

export function dueRefreshes(accounts: FreshAccount[], dropAt: number, now: number, freshMin: number, spanMs = STAGGER_MS): RefreshSlot[] {
  return staggerPlan(accounts, dropAt, now, freshMin, spanMs).filter((slot) => slot.at <= now && slot.at >= dropAt - spanMs)
}

export interface BindingAccount {
  id: string
  label: string
  proxyGroupId: string | null
  stickyProxyId?: string | null
  stickyProxyLabel?: string | null
}

export interface BindingGroup {
  id: string
  name: string
  proxies: { id: string }[]
}

export interface EffectiveBinding {
  accountLabel: string
  accountSource: "task" | "none"
  proxyLabel: string
  proxySource: "account" | "task" | "direct"
  profileLabel: string
  profileSource: "account" | "none"
  warnings: BindingWarning[]
}

export function effectiveBinding(input: {
  accountId: string
  proxyGroupId: string | null
  monitorProxyGroupId: string | null
  account: BindingAccount | null
  groups: BindingGroup[]
}): EffectiveBinding {
  const account = input.accountId ? input.account : null
  if (!account) {
    const group = input.groups.find((item) => item.id === input.proxyGroupId)
    return {
      accountLabel: "",
      accountSource: "none",
      proxyLabel: group?.name ?? "",
      proxySource: group ? "task" : "direct",
      profileLabel: "",
      profileSource: "none",
      warnings: []
    }
  }
  const taskGroup = input.groups.find((item) => item.id === input.proxyGroupId)
  const accountGroup = input.groups.find((item) => item.id === account.proxyGroupId)
  const warnings: BindingWarning[] = []
  const stickyId = account.stickyProxyId ?? ""
  if (input.proxyGroupId && stickyId && taskGroup && !taskGroup.proxies.some((proxy) => proxy.id === stickyId)) warnings.push("sticky")
  else if (input.proxyGroupId && account.proxyGroupId && input.proxyGroupId !== account.proxyGroupId) warnings.push("sticky")
  const monitorSame = !input.monitorProxyGroupId || input.monitorProxyGroupId === (account.proxyGroupId || input.proxyGroupId)
  if (!monitorSame) warnings.push("monitor")
  const proxyLabel = account.stickyProxyLabel || accountGroup?.name || ""
  return {
    accountLabel: account.label,
    accountSource: "task",
    proxyLabel,
    proxySource: proxyLabel ? "account" : "direct",
    profileLabel: accountPartition(account.id),
    profileSource: "account",
    warnings
  }
}

/**
 * Caps simultaneous hidden session windows. Jobs past the cap wait until one finishes.
 * This does not change the browser, the proxy, or the cookies.
 */
export class SessionWindowQueue {
  private cap: number
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(cap = DEFAULT_WINDOW_CAP) {
    this.cap = DEFAULT_WINDOW_CAP
    this.setCap(cap)
  }

  setCap(cap: number): void {
    const next = Math.round(Number(cap))
    this.cap = Number.isFinite(next) ? Math.min(10, Math.max(1, next)) : DEFAULT_WINDOW_CAP
    this.drain()
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await job()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.cap) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.active += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    this.drain()
  }

  private drain(): void {
    while (this.active < this.cap && this.waiters.length) {
      this.waiters.shift()?.()
    }
  }
}
