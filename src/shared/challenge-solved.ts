import type { StoreId } from "./types"

/**
 * 0.2.40: notice when a PERSON has cleared a store check, so the task can resume on its own.
 * This only reads the page the person is looking at and the cookies it set. It never clicks,
 * holds, scripts, or fakes anything on the challenge itself, and nothing goes to a solving service.
 */
export const CHALLENGE_MARKERS = [
  "px-captcha",
  "perimeterx",
  "press & hold",
  "press and hold",
  "press &amp; hold",
  "verify you are human",
  "are you a human",
  "robot check",
  "captcha",
  "access denied",
  "_pxblock"
]

/** Cookies a store's bot check rotates when it is cleared. Target uses PerimeterX (_px3). */
export const SOLVE_COOKIES: Partial<Record<StoreId, string[]>> = {
  target: ["_px3", "_pxhd", "_px2"],
  walmart: ["_px3", "_pxhd"]
}

export interface PageProbe {
  /** Final URL of the page the person is on. */
  url: string
  /** Start of the page HTML (or document text). */
  html: string
  /** Cookies the page has now (name -> value). */
  cookies: Record<string, string>
}

export type SolvedVerdict = { solved: true; why: string } | { solved: false; why: string }

export function pageShowsChallenge(html: string): boolean {
  const text = html.slice(0, 60_000).toLowerCase()
  return CHALLENGE_MARKERS.some((marker) => text.includes(marker))
}

export function cookieMap(header: string): Record<string, string> {
  const map: Record<string, string> = {}
  for (const part of header.split(";")) {
    const index = part.indexOf("=")
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    if (name) map[name] = part.slice(index + 1).trim()
  }
  return map
}

/**
 * Solved = the store page loads normally (no challenge markers, real content, still on the store)
 * AND the store's bot-check cookie was set or changed since the handoff opened.
 * Stores without a known check cookie only need a normal page plus any new/changed cookie.
 */
export function challengeSolved(store: StoreId, host: string, seed: Record<string, string>, now: PageProbe): SolvedVerdict {
  let pageHost = ""
  try {
    pageHost = new URL(now.url).hostname
  } catch {
    return { solved: false, why: "The page has not loaded yet." }
  }
  if (pageHost !== host && !pageHost.endsWith(`.${host.replace(/^www\./, "")}`)) return { solved: false, why: "The page left the store." }
  if (now.html.length < 1500) return { solved: false, why: "The page is still loading." }
  if (pageShowsChallenge(now.html)) return { solved: false, why: "The check is still on screen." }
  const watched = SOLVE_COOKIES[store]
  if (watched) {
    const fresh = watched.find((name) => now.cookies[name] && now.cookies[name] !== seed[name])
    return fresh ? { solved: true, why: `Store page loaded and ${fresh} was refreshed.` } : { solved: false, why: "Waiting for the store to accept the check." }
  }
  const changed = Object.keys(now.cookies).find((name) => now.cookies[name] !== seed[name])
  return changed ? { solved: true, why: "Store page loaded normally." } : { solved: false, why: "Waiting for the store to accept the check." }
}

/**
 * Script for the phone WebView. Every 1.5s it reads document.cookie and the page text and posts
 * {type:"solved", cookie} once the same rule as challengeSolved() passes. Read-only.
 */
export function solvedProbeScript(store: StoreId, host: string, seedHeader: string): string {
  const config = JSON.stringify({ markers: CHALLENGE_MARKERS, watched: SOLVE_COOKIES[store] ?? null, host, seed: cookieMap(seedHeader) })
  return `(() => {
  const cfg = ${config};
  let sent = false;
  const read = () => { const out = {}; for (const part of (document.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); } return out; };
  const tick = () => {
    if (sent) return;
    try {
      const h = location.hostname;
      if (h !== cfg.host && !h.endsWith("." + cfg.host.replace(/^www\\./, ""))) return;
      const html = (document.documentElement && document.documentElement.outerHTML || "").slice(0, 60000);
      if (html.length < 1500) return;
      const lower = html.toLowerCase();
      if (cfg.markers.some((m) => lower.includes(m))) return;
      const now = read();
      const names = cfg.watched || Object.keys(now);
      const fresh = names.find((n) => now[n] && now[n] !== cfg.seed[n]);
      if (!fresh) return;
      sent = true;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: "solved", cookie: document.cookie || "" }));
    } catch (e) {}
  };
  setInterval(tick, 1500);
  true;
})(); true;`
}
