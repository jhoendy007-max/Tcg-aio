import { randomUUID } from "node:crypto"
import { applySolvedCookies } from "./challenge"
import type { ProxyEndpoint, PublicChallenge, SessionCookies, StoreId } from "../shared/types"

export interface ChallengeRequest {
  taskId: string
  store: StoreId
  storeName: string
  sku: string
  url: string
  reason: string
  proxyLabel: string
  cookie: string
  session?: SessionCookies
  proxy?: ProxyEndpoint
}

export type ChallengeWait =
  | { kind: "solved"; cookies: string }
  | { kind: "timeout" }
  | { kind: "dismissed" }
  | { kind: "aborted" }
  | { kind: "busy" }

interface Waiter {
  request: ChallengeRequest
  public: PublicChallenge
  finish: (outcome: ChallengeWait) => boolean
}

/**
 * One in-memory handoff. The desktop browser and the paired phone share it.
 * Cookies stay here until a person submits them. Nothing is sent to a solving service.
 */
export class ChallengeGate {
  private waiter: Waiter | null = null
  private readonly listeners = new Set<(challenge: PublicChallenge | null) => void>()

  onChange(listener: (challenge: PublicChallenge | null) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  current(): PublicChallenge | null {
    return this.waiter?.public ?? null
  }

  /** Seed cookie and proxy for the desktop browser. Not part of the public event. */
  currentRequest(): ChallengeRequest | null {
    return this.waiter?.request ?? null
  }

  /** Phone handoff view. The cookie is only for this message, never a normal snapshot. */
  phoneView(): (PublicChallenge & { cookie: string }) | null {
    if (!this.waiter) return null
    return { ...this.waiter.public, cookie: this.waiter.request.cookie.slice(0, 8192) }
  }

  wait(request: ChallengeRequest, signal: AbortSignal, timeoutSec: number): Promise<ChallengeWait> {
    if (this.waiter) return Promise.resolve({ kind: "busy" })
    if (signal.aborted) return Promise.resolve({ kind: "aborted" })
    const timeoutMs = Math.max(1, Math.round(timeoutSec * 1000))
    return new Promise((resolve) => {
      const id = randomUUID()
      let settled = false
      const finish = (outcome: ChallengeWait) => {
        if (settled || this.waiter?.public.id !== id) return false
        settled = true
        clearTimeout(timer)
        signal.removeEventListener("abort", onAbort)
        this.waiter = null
        this.emit(null)
        resolve(outcome)
        return true
      }
      const onAbort = () => finish({ kind: "aborted" })
      const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs)
      signal.addEventListener("abort", onAbort, { once: true })
      const view: PublicChallenge = {
        id,
        taskId: request.taskId,
        store: request.store,
        storeName: request.storeName,
        sku: request.sku,
        url: request.url,
        reason: request.reason,
        expiresAt: Date.now() + timeoutMs,
        proxyLabel: request.proxyLabel
      }
      this.waiter = { request, public: view, finish }
      this.emit(view)
    })
  }

  submit(id: string, header: string): void {
    const waiter = this.require(id)
    const cookies = header.replace(/[\r\n]/g, "").trim()
    applySolvedCookies(waiter.request.session, cookies)
    if (!waiter.finish({ kind: "solved", cookies })) throw new Error("That challenge is no longer waiting.")
  }

  dismiss(id: string): void {
    this.require(id).finish({ kind: "dismissed" })
  }

  private require(id: string): Waiter {
    if (!this.waiter || this.waiter.public.id !== id) throw new Error("That challenge is no longer waiting.")
    return this.waiter
  }

  private emit(challenge: PublicChallenge | null): void {
    for (const listener of this.listeners) listener(challenge)
  }
}
