export interface AlertSeen {
  key: string
  at: number
}

export function parseAllowlist(text: string): string[] {
  const seen = new Set<string>()
  for (const raw of text.split(/[\n,]+/)) {
    const token = raw.trim().toLowerCase()
    if (!token || token.length > 80) continue
    seen.add(token)
    if (seen.size >= 40) break
  }
  return [...seen]
}

/** An empty list keeps the saved channels and the authenticated local webhook. */
export function sourceAllowed(allowlist: string[], sources: string[]): boolean {
  if (!allowlist.length) return true
  const have = new Set(sources.map((source) => source.trim().toLowerCase()).filter(Boolean))
  return allowlist.some((token) => have.has(token))
}

export function dedupeHit(seen: AlertSeen[], key: string, now: number, windowMin: number): { fresh: boolean; seen: AlertSeen[] } {
  const windowMs = Math.max(0, windowMin) * 60_000
  const freshSeen = seen.filter((item) => now - item.at < Math.max(windowMs, 24 * 60 * 60 * 1000))
  if (windowMs <= 0) return { fresh: true, seen: freshSeen }
  const prior = freshSeen.find((item) => item.key === key && now - item.at < windowMs)
  if (prior) return { fresh: false, seen: freshSeen }
  return { fresh: true, seen: [{ key, at: now }, ...freshSeen].slice(0, 200) }
}

export function channelIdsFrom(text: string): string[] {
  const ids: string[] = []
  for (const raw of text.split(/[\s,]+/)) {
    const id = raw.trim()
    if (!/^\d{17,22}$/.test(id) || ids.includes(id)) continue
    ids.push(id)
    if (ids.length >= 20) break
  }
  return ids
}
