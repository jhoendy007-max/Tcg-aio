import { dropOpsText, type DropLang } from "../shared/drop-ops"
import { sessionFreshness } from "../shared/consistency"
import type { Address, ProxyScore, PublicAccount, PublicProfile, PublicTask, SchedulePhase } from "../shared/types"

export interface RehearsalSchedule {
  enabled: boolean
  phase: SchedulePhase
  startAt: number
  rehearsalMin: number
  rehearsalAt?: number | null
}

export function rehearsalDue(schedule: RehearsalSchedule, now: number): boolean {
  if (!schedule.enabled || schedule.phase === "stopped" || schedule.phase === "started") return false
  const lead = Math.max(0, schedule.rehearsalMin) * 60_000
  if (lead <= 0) return false
  if (schedule.rehearsalAt) return false
  return now >= schedule.startAt - lead && now < schedule.startAt
}

export function rehearseDrop(input: {
  tasks: PublicTask[]
  accounts: PublicAccount[]
  profiles: PublicProfile[]
  scores: ProxyScore[]
  now: number
  freshMin: number
  lang?: DropLang
}): { ok: boolean; lines: string[]; detail: string } {
  const lang = input.lang === "es" ? "es" : "en"
  const lines: string[] = []
  if (!input.tasks.length) lines.push(lang === "es" ? "Ninguna tarea coincide con este drop." : "No tasks match this drop.")
  for (const task of input.tasks) {
    lines.push(...checkTask(task, input, lang))
  }
  const ok = lines.length === 0
  const head = dropOpsText(lang, ok ? "rehearsalPass" : "rehearsalFail")
  const body = ok ? head : `${head} ${lines.join(" ")}`
  const detail = `${body} ${dropOpsText(lang, "noOrder")}`.slice(0, 900)
  return { ok, lines, detail }
}

function checkTask(task: PublicTask, input: { accounts: PublicAccount[]; profiles: PublicProfile[]; scores: ProxyScore[]; now: number; freshMin: number }, lang: DropLang): string[] {
  const problems: string[] = []
  const label = task.sku
  if (!task.accountId) {
    problems.push(lang === "es" ? `${label}: la tarea no tiene cuenta.` : `${label}: the task has no account.`)
  } else {
    const account = input.accounts.find((item) => item.id === task.accountId)
    if (!account) {
      problems.push(lang === "es" ? `${label}: la cuenta no está.` : `${label}: the account is missing.`)
    } else {
      const freshness = sessionFreshness(account, input.now, input.freshMin)
      if (freshness === "missing") problems.push(lang === "es" ? `${account.label}: no hay sesión guardada.` : `${account.label}: no saved session.`)
      if (freshness === "expired") problems.push(lang === "es" ? `${account.label}: la sesión expiró.` : `${account.label}: the session expired.`)
      if (freshness === "stale") problems.push(lang === "es" ? `${account.label}: la sesión está vieja.` : `${account.label}: the session is stale.`)
      if (!account.stickyProxyId) {
        problems.push(lang === "es" ? `${account.label}: no hay proxy fijo.` : `${account.label}: no sticky proxy is pinned.`)
      } else {
        const score = input.scores.find((item) => item.proxyId === account.stickyProxyId)
        if (score && score.benchedUntil > input.now) {
          problems.push(lang === "es" ? `${account.label}: el proxy fijo está en cuarentena.` : `${account.label}: the sticky proxy is quarantined.`)
        }
      }
    }
  }
  const profile = input.profiles.find((item) => item.id === task.profileId)
  if (!profile) {
    problems.push(lang === "es" ? `${label}: el perfil no está.` : `${label}: the profile is missing.`)
  } else {
    if (!addressReady(profile.shipping)) problems.push(lang === "es" ? `${profile.name}: la dirección está incompleta.` : `${profile.name}: the address is incomplete.`)
    if (!/^\d{4}$/.test(profile.last4)) problems.push(lang === "es" ? `${profile.name}: faltan los últimos cuatro de la tarjeta.` : `${profile.name}: the card last four is missing.`)
    else if (cardExpired(profile.expMonth, profile.expYear, input.now)) problems.push(lang === "es" ? `${profile.name}: la tarjeta está vencida.` : `${profile.name}: the card is expired.`)
  }
  return problems
}

function addressReady(address: Address): boolean {
  return Boolean(address.line1.trim() && address.city.trim() && /^[A-Z]{2}$/.test(address.state) && /^\d{5}(?:-\d{4})?$/.test(address.zip))
}

function cardExpired(month: string, year: string, now: number): boolean {
  const expMonth = Number(month)
  const expYear = Number(year.length === 2 ? `20${year}` : year)
  if (!Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12 || !Number.isInteger(expYear)) return true
  const current = new Date(now)
  const cursor = current.getUTCFullYear() * 12 + current.getUTCMonth()
  return expYear * 12 + (expMonth - 1) < cursor
}
