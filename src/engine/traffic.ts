import type { HttpResponse } from "./http"

export type TrafficKind = "clear" | "rate_limit" | "hard_block" | "challenge" | "queue"

const PERSON_MARKERS = [
  "verify you are human",
  "please verify you are a human",
  "press and hold",
  "press-and-hold",
  "robot check",
  "robot or human",
  "just a moment",
  "challenge-platform",
  "attention required",
  "pardon our interruption"
]

const CHALLENGE_MARKERS = [
  ...PERSON_MARKERS,
  "captcha",
  "access denied"
]

/** True when the page text is asking a person to pass a check. JSON error bodies are not pages. */
export function pageLooksLikeChallenge(text: string): boolean {
  const lower = text.toLowerCase()
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker))
}

export function classifyTraffic(response: Pick<HttpResponse, "status" | "body" | "headers">): TrafficKind {
  if (isProductQueue(response)) return "queue"
  if (looksLikeWaitingRoom(response)) {
    return activePersonPrompt(response.body) ? "challenge" : "queue"
  }
  if (htmlChallenge(response.body)) return "challenge"
  if (response.status === 429) return "rate_limit"
  if (response.status === 403 || response.status === 412 || response.status === 435) return "hard_block"
  return "clear"
}

/** How long to wait before the next legitimate queue check. The page's own interval wins. */
export function queuePollMs(response: Pick<HttpResponse, "body" | "headers">, fallbackMs: number, now = Date.now()): number {
  const fromHeader = retryAfterMs(response.headers, now)
  const fromBody = intervalFromBody(response.body)
  return clampWait(fromHeader ?? fromBody ?? fallbackMs)
}

export function queueDetail(response: Pick<HttpResponse, "body">): string {
  const ahead = response.body.match(/"usersInLineAheadOfYou"\s*:\s*(\d+)/i)?.[1]
    ?? response.body.match(/"queueNumber"\s*:\s*(\d+)/i)?.[1]
  if (ahead) return `In queue. Ahead of you: ${ahead}.`
  return "In queue. Waiting for the store to let this session through."
}

export async function pollQueue(
  first: HttpResponse,
  options: {
    method: string
    fallbackMs: number
    signal: AbortSignal
    sleep: (ms: number) => Promise<void>
    again: () => Promise<HttpResponse>
    onQueue: (detail: string, waitMs: number) => void
  }
): Promise<HttpResponse> {
  const method = options.method.toUpperCase()
  if (method !== "GET" && method !== "HEAD") return first
  let response = first
  const prior: string[] = []
  while (classifyTraffic(response) === "queue") {
    if (options.signal.aborted) break
    const wait = queuePollMs(response, options.fallbackMs)
    options.onQueue(queueDetail(response), wait)
    prior.push(...setCookieList(response.headers))
    await options.sleep(wait)
    if (options.signal.aborted) break
    response = await options.again()
  }
  return mergeCookies(response, prior)
}

function looksLikeWaitingRoom(response: Pick<HttpResponse, "body" | "headers">): boolean {
  const location = headerValue(response.headers, "location")
  const text = `${location}\n${response.body.slice(0, 12000)}`.toLowerCase()
  if (text.includes("queue-it.net") || text.includes("queue-it.com")) return true
  if (text.includes("usersinlineaheadofyou") || text.includes("you are now in line")) return true
  if (text.includes("waiting room") && (text.includes("queue") || text.includes("in line"))) return true
  return false
}

function isProductQueue(response: Pick<HttpResponse, "body" | "headers">): boolean {
  const wait = headerValue(response.headers, "a2ctransactionwait") || headerValue(response.headers, "a2ctransactioncode")
  if (wait) return true
  const text = response.body.slice(0, 2000)
  return text.includes("CONSTRAINED_ITEM") || text.includes("PLEASE_WAIT")
}

function activePersonPrompt(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false
  const lower = body.toLowerCase()
  return PERSON_MARKERS.some((marker) => lower.includes(marker))
}

function htmlChallenge(body: string): boolean {
  const trimmed = body.trim()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false
  if (!pageLooksLikeChallenge(body)) return false
  const lower = trimmed.slice(0, 400).toLowerCase()
  return lower.includes("<html") || lower.includes("<!doctype") || lower.includes("<head") || lower.includes("<body")
}

function intervalFromBody(body: string): number | null {
  const named = body.match(/"(?:updateIntervalMs|updateInterval|pollInterval)"\s*:\s*(\d+)/i)
  if (named) {
    const value = Number(named[1])
    if (value >= 1000 && value <= 120000) return value
  }
  const seconds = body.match(/(?:please wait|check(?:ing)? again in|refresh(?:ing)? in|try again in)\D{0,40}(\d{1,3})\s*(?:seconds|secs|s)\b/i)
  if (seconds) {
    const value = Number(seconds[1])
    if (value >= 1 && value <= 120) return value * 1000
  }
  return null
}

function retryAfterMs(headers: HttpResponse["headers"], now: number): number | null {
  const raw = headerValue(headers, "retry-after").trim()
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(raw)
  if (Number.isFinite(at)) return at - now
  return null
}

function clampWait(ms: number): number {
  if (!Number.isFinite(ms) || ms < 1000) return 1000
  return Math.min(120000, Math.round(ms))
}

function headerValue(headers: HttpResponse["headers"], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

function setCookieList(headers: HttpResponse["headers"]): string[] {
  const value = headers["set-cookie"] ?? headers["Set-Cookie"]
  if (!value) return []
  return (Array.isArray(value) ? value : [value]).filter((item) => item.trim())
}

function mergeCookies(response: HttpResponse, prior: string[]): HttpResponse {
  if (!prior.length) return response
  const own = setCookieList(response.headers)
  return { ...response, headers: { ...response.headers, "set-cookie": [...prior, ...own] } }
}
