import { STOCK_CHECK_TIMEOUT } from "./chromium-session"
import type { Settings } from "../shared/types"

/**
 * Proxy failover (0.2.45). When a run fails for a reason that belongs to the proxy, the task moves to the
 * next healthy proxy in its group. Failures that belong to the store account, the card, the item or the
 * form never rotate. Rotation never touches a store's fingerprint checks: it only changes which proxy the
 * same browser profile talks through.
 */
export type FailureKind = "connect" | "timeout" | "tunnel" | "proxy-auth" | "blocked" | "challenge" | "other"

export interface FailureVerdict {
  rotate: boolean
  kind: FailureKind
  why: string
}

/** Reasons that are about the card, the item, the login or the form. These never rotate a proxy. */
const NOT_THE_PROXY = [
  /\bdeclin(?:e|ed|es)\b|payment_declined|card_declined/i,
  /out of stock|sold out|not available|unavailable for shipping/i,
  /password|could not find that account|_ERR_USER|_ERR_AUTH|needs a sign-in|session (?:has )?expired|sign in again|unauthorized/i,
  /^(?:enter|choose|confirm|add|paste|save)\b|v1 places|not registered|invalid|required|must be|too long|too short/i,
  /spend limit|max of|above this checkout|order limit|checkout limit|already ordered|quantity/i,
  /verification code|two-step|otp|mailbox/i,
  /the task was stopped|aborted/i
]

const BLOCK_STATUS = /(?:\bhttp\s*|\(|\bstatus\s*|\banswered\s*|\breturned\s*)(403|412|429|435)\b/i

export function classifyFailure(input: { reason?: string; error?: unknown; canHandoff?: boolean }): FailureVerdict {
  const raw = input.error !== undefined ? (input.error instanceof Error ? input.error.message : String(input.error)) : input.reason ?? ""
  const text = raw.trim()
  if (!text) return { rotate: false, kind: "other", why: "No reason was given." }
  if (/ERR_TUNNEL|PROXY_CONNECTION_FAILED|proxy tunnel/i.test(text)) return { rotate: true, kind: "tunnel", why: "The proxy tunnel failed." }
  if (/\b407\b|proxy auth|PROXY_AUTH/i.test(text)) return { rotate: true, kind: "proxy-auth", why: "The proxy refused its login (407)." }
  if (/proxy failed|ERR_PROXY/i.test(text)) return { rotate: true, kind: "connect", why: "The proxy connection failed." }
  if (NOT_THE_PROXY.some((pattern) => pattern.test(text))) return { rotate: false, kind: "other", why: "Not a proxy problem." }
  if (text === STOCK_CHECK_TIMEOUT || /timed out|ETIMEDOUT|ERR_TIMED_OUT/i.test(text)) return { rotate: true, kind: "timeout", why: "The proxy or the store did not answer in time." }
  if (/ECONNREFUSED|ECONNRESET|ERR_CONNECTION|connection closed|could not be reached|ENOTFOUND|EAI_AGAIN/i.test(text)) {
    return { rotate: true, kind: "connect", why: "The proxy connection failed." }
  }
  if (/blocked this proxy|store blocked|blocked this connection|blocked by the store/i.test(text) || BLOCK_STATUS.test(text)) {
    return { rotate: true, kind: "blocked", why: "The store blocked this proxy." }
  }
  if (input.canHandoff === false && /presented a challenge|perimeterx|robot check|captcha|challenge/i.test(text)) {
    return { rotate: true, kind: "challenge", why: "The store showed a check that cannot be handed to a person here." }
  }
  return { rotate: false, kind: "other", why: "Not a proxy problem." }
}

export interface FailoverPolicy {
  enabled: boolean
  maxRotations: number
}

export function failoverPolicy(task: { rotateProxy?: boolean | null; maxRotations?: number | null }, settings: Pick<Settings, "rotateProxyOnFailure" | "maxProxyRotations">): FailoverPolicy {
  const max = typeof task.maxRotations === "number" && task.maxRotations >= 1 ? task.maxRotations : settings.maxProxyRotations
  return {
    enabled: typeof task.rotateProxy === "boolean" ? task.rotateProxy : settings.rotateProxyOnFailure !== false,
    maxRotations: Math.min(10, Math.max(1, Math.round(max) || 3))
  }
}

export type RotateDecision =
  | { ok: true }
  | { ok: false; reason: "off" | "limit" | "order-sent" | "not-proxy" | "no-proxy" }

/**
 * May this failure rotate the proxy right now? Never after a place-order request went out (the order
 * might have been placed). Never past the rotation cap. Never for a failure that is not the proxy's.
 */
export function mayRotate(input: { verdict: FailureVerdict; policy: FailoverPolicy; rotations: number; orderSent: boolean; hasProxy: boolean }): RotateDecision {
  if (!input.policy.enabled) return { ok: false, reason: "off" }
  if (!input.verdict.rotate) return { ok: false, reason: "not-proxy" }
  if (input.orderSent) return { ok: false, reason: "order-sent" }
  if (!input.hasProxy) return { ok: false, reason: "no-proxy" }
  if (input.rotations >= input.policy.maxRotations) return { ok: false, reason: "limit" }
  return { ok: true }
}

export function rotationLine(input: { fromLabel: string; fromIndex?: number; toLabel: string; toIndex?: number; total: number; n: number; max: number; cooldownMs: number; why: string }): string {
  const place = (index: number | undefined) => (index && input.total ? ` (${index} of ${input.total})` : "")
  const minutes = Math.round(input.cooldownMs / 60_000)
  return `Proxy rotation ${input.n}/${input.max}: ${input.fromLabel}${place(input.fromIndex)} → ${input.toLabel}${place(input.toIndex)}. ${input.why} The old proxy rests ${minutes} min.`
}
