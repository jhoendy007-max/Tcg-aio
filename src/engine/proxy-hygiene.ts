import type { ProxyEndpoint, ProxyScore, StoreBlockRate, StoreId } from "../shared/types"

export const BENCH_AFTER = 3
export const BENCH_MS = 30 * 60 * 1000

export interface StickyPin {
  accountId: string
  groupId: string
  proxyId: string
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
}

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
  if (status === 403 || status === 412 || status === 429 || status === 435) {
    score.streak += 1
    score.blocks += 1
    if (score.streak >= benchAfter) score.benchedUntil = now + benchMs
  } else if (status >= 200 && status < 400) {
    score.streak = 0
    score.ok += 1
    score.benchedUntil = 0
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

/** Keep one proxy for an account. Move to another only after that proxy is benched. */
export function chooseSticky(
  proxies: ProxyEndpoint[],
  pins: StickyPin[],
  scores: ProxyScore[],
  accountId: string,
  groupId: string,
  now: number
): { choice: ProxyChoice; pins: StickyPin[] } {
  if (!proxies.length) return { choice: { rotated: false, allBenched: false }, pins }
  const nextPins = pins.map((pin) => ({ ...pin }))
  const pin = nextPins.find((item) => item.accountId === accountId && item.groupId === groupId)
  const scoreFor = (id: string) => scores.find((score) => score.proxyId === id)
  const healthy = proxies.filter((proxy) => !isBenched(scoreFor(proxy.id), now))
  const pinned = pin ? proxies.find((proxy) => proxy.id === pin.proxyId) : undefined
  if (pinned && !isBenched(scoreFor(pinned.id), now)) {
    return { choice: { proxy: pinned, rotated: false, allBenched: false }, pins: nextPins }
  }
  const pool = healthy.length ? healthy : proxies
  const ranked = [...pool].sort((a, b) => (scoreFor(a.id)?.streak ?? 0) - (scoreFor(b.id)?.streak ?? 0))
  const proxy = ranked[0]
  if (pin) pin.proxyId = proxy.id
  else nextPins.push({ accountId, groupId, proxyId: proxy.id })
  return {
    choice: { proxy, rotated: Boolean(pinned && pinned.id !== proxy.id), allBenched: healthy.length === 0 },
    pins: nextPins
  }
}
