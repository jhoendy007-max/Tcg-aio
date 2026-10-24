import type { ProxyEndpoint, ProxyScore, StoreBlockRate, StoreId } from "../shared/types"

export const BENCH_AFTER = 3
export const BENCH_MS = 30 * 60 * 1000

export interface StickyPin {
  accountId: string
  groupId: string
  proxyId: string
  /** Account pins are exclusive. A task without an account sets this false and may share with other tasks. */
  exclusive?: boolean
}

export interface BlockTally {
  store: StoreId
  samples: number
  blocked: number
}

export interface ProxyChoice {
  proxy?: ProxyEndpoint
  rotated: boolean
  allBenched: boolean
  /** The account already has a sticky proxy that is not in this group. */
  stickyOutside?: boolean
  heldProxyId?: string
}

const QUARANTINE = new Set([403, 412, 435])

export function noteScore(
  scores: ProxyScore[],
  proxyId: string | undefined,
  status: number | null,
  now: number,
  benchAfter = BENCH_AFTER,
  benchMs = BENCH_MS
): ProxyScore[] {
  if (!proxyId || status === null) return scores
  const next = scores.map((score) => ({ ...score }))
  let score = next.find((item) => item.proxyId === proxyId)
  if (!score) {
    score = { proxyId, streak: 0, ok: 0, blocks: 0, benchedUntil: 0, lastStatus: null }
    next.push(score)
  }
  score.lastStatus = status
  if (QUARANTINE.has(status)) {
    score.streak += 1
    score.blocks += 1
    if (score.streak >= benchAfter) score.benchedUntil = now + benchMs
  } else if (status >= 200 && status < 400) {
    score.streak = 0
    score.ok += 1
    score.benchedUntil = 0
    score.failures = 0
  }
  return next
}

export function noteBlock(tallies: BlockTally[], store: StoreId, blocked: boolean): BlockTally[] {
  const next = tallies.map((tally) => ({ ...tally }))
  let tally = next.find((item) => item.store === store)
  if (!tally) {
    tally = { store, samples: 0, blocked: 0 }
    next.push(tally)
  }
  tally.samples += 1
  if (blocked) tally.blocked += 1
  if (tally.samples > 50) {
    const scale = 50 / tally.samples
    tally.samples = 50
    tally.blocked = Math.round(tally.blocked * scale)
  }
  return next
}

export function blockRate(tallies: BlockTally[], store: StoreId): StoreBlockRate {
  const tally = tallies.find((item) => item.store === store)
  const samples = tally?.samples ?? 0
  const blocked = tally?.blocked ?? 0
  return { store, samples, blocked, rate: samples ? blocked / samples : 0 }
}

export function isBenched(score: ProxyScore | undefined, now: number): boolean {
  return Boolean(score && score.benchedUntil > now)
}

/**
 * One proxy per owner. Account owners never share a proxy. A move happens only
 * after the current proxy is quarantined, and only when the caller asks again.
 */
export function chooseSticky(
  proxies: ProxyEndpoint[],
  pins: StickyPin[],
  scores: ProxyScore[],
  accountId: string,
  groupId: string,
  now: number,
  exclusive = true
): { choice: ProxyChoice; pins: StickyPin[] } {
  const { pin, rest } = splitOwner(pins, accountId)
  if (!proxies.length) {
    return { choice: { rotated: false, allBenched: false, stickyOutside: Boolean(pin), heldProxyId: pin?.proxyId }, pins: pin ? [pin, ...rest] : rest }
  }
  const scoreFor = (id: string) => scores.find((score) => score.proxyId === id)
  const reserved = new Set(rest.filter((item) => exclusive || item.exclusive !== false).map((item) => item.proxyId))
  if (pin && !isBenched(scoreFor(pin.proxyId), now)) {
    const pinned = proxies.find((proxy) => proxy.id === pin.proxyId)
    if (pinned) return { choice: { proxy: pinned, rotated: false, allBenched: false }, pins: [pin, ...rest] }
    if (pin.exclusive !== false) {
      return { choice: { rotated: false, allBenched: false, stickyOutside: true, heldProxyId: pin.proxyId }, pins: [pin, ...rest] }
    }
  }
  const free = proxies.filter((proxy) => !reserved.has(proxy.id))
  const healthy = free.filter((proxy) => !isBenched(scoreFor(proxy.id), now))
  const pool = healthy.length ? healthy : free
  if (!pool.length) {
    return { choice: { rotated: false, allBenched: true, stickyOutside: Boolean(pin), heldProxyId: pin?.proxyId }, pins: pin ? [pin, ...rest] : rest }
  }
  const ranked = [...pool].sort((a, b) => (scoreFor(a.id)?.streak ?? 0) - (scoreFor(b.id)?.streak ?? 0))
  const proxy = ranked[0]
  const nextPin: StickyPin = { accountId, groupId, proxyId: proxy.id, exclusive }
  return {
    choice: { proxy, rotated: Boolean(pin && pin.proxyId !== proxy.id), allBenched: healthy.length === 0 },
    pins: [nextPin, ...rest]
  }
}

function splitOwner(pins: StickyPin[], accountId: string): { pin?: StickyPin; rest: StickyPin[] } {
  const rest: StickyPin[] = []
  let pin: StickyPin | undefined
  for (const item of pins) {
    if (item.accountId === accountId) {
      if (!pin) pin = { ...item }
    } else rest.push({ ...item })
  }
  return { pin, rest }
}

/** Cooldown after the nth failure in a row: 5, 10, 20, then 30 minutes. */
export function failoverCooldownMs(failures: number): number {
  const step = Math.min(Math.max(1, Math.round(failures)) - 1, 3)
  return Math.min(30, 5 * 2 ** step) * 60_000
}

/** Mark a proxy failed. It sits out its cooldown and is skipped by every pick until then. */
export function failProxy(scores: ProxyScore[], proxyId: string, kind: string, now: number): { scores: ProxyScore[]; cooldownMs: number } {
  const next = scores.map((score) => ({ ...score }))
  let score = next.find((item) => item.proxyId === proxyId)
  if (!score) {
    score = { proxyId, streak: 0, ok: 0, blocks: 0, benchedUntil: 0, lastStatus: null }
    next.push(score)
  }
  score.failures = (score.failures ?? 0) + 1
  score.lastFailKind = kind
  const cooldownMs = failoverCooldownMs(score.failures)
  score.benchedUntil = Math.max(score.benchedUntil, now + cooldownMs)
  return { scores: next, cooldownMs }
}

export interface Rotation {
  proxy?: ProxyEndpoint
  exhausted: boolean
  previousId: string
  pins: StickyPin[]
  /** 1-based position in the group, for logs. */
  index?: number
  total: number
}

/**
 * Move one owner (an account, or a task without one) off a failed proxy onto the next healthy one in
 * its group. The pin only changes here. When no healthy proxy is left the old pin is kept and
 * `exhausted` is true, so the caller can stop with a clear message.
 */
export function rotateSticky(
  proxies: ProxyEndpoint[],
  pins: StickyPin[],
  scores: ProxyScore[],
  ownerId: string,
  groupId: string,
  failedId: string,
  now: number,
  exclusive = true
): Rotation {
  const { pin, rest } = splitOwner(pins, ownerId)
  const scoreFor = (id: string) => scores.find((score) => score.proxyId === id)
  const reserved = new Set(rest.filter((item) => exclusive || item.exclusive !== false).map((item) => item.proxyId))
  const candidates = proxies.filter((proxy) => proxy.id !== failedId && !reserved.has(proxy.id) && !isBenched(scoreFor(proxy.id), now))
  if (!candidates.length) {
    return { exhausted: true, previousId: failedId, pins: pin ? [pin, ...rest] : rest, total: proxies.length }
  }
  const ranked = [...candidates].sort((a, b) => (scoreFor(a.id)?.streak ?? 0) - (scoreFor(b.id)?.streak ?? 0))
  const proxy = ranked[0]
  return {
    proxy,
    exhausted: false,
    previousId: failedId,
    pins: [{ accountId: ownerId, groupId, proxyId: proxy.id, exclusive }, ...rest],
    index: proxies.findIndex((item) => item.id === proxy.id) + 1,
    total: proxies.length
  }
}
