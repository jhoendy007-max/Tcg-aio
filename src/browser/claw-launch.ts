import { execFile } from "node:child_process"
import { chromium, type Browser, type BrowserContext } from "playwright-core"
import { Semaphore } from "./semaphore"

/**
 * Launches one Clawbrowser profile through `clawctl` and attaches over CDP.
 * The profile name is the identity: the same name reuses the same cached
 * profile (cookies, storage, and the fingerprint Clawbrowser itself assigned).
 * This module never overrides fingerprint properties.
 */
export interface ClawLaunchOptions {
  /** Stable profile name, for example `acct-${accountId}`. */
  profile: string
  url?: string
  clawctl?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ClawBrowser {
  profile: string
  endpoint: string
  browser: Browser
  context: BrowserContext
  close(options?: { stopProfile?: boolean }): Promise<void>
}

export const MAX_CLAW_PROFILES = 500

const ENDPOINT = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/

export function profileName(raw: string): string {
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 64)
  if (!clean) throw new Error("Clawbrowser profile name is empty.")
  return clean
}

/** Finds the local CDP endpoint in `clawctl --json` output, or in plain text. */
export function parseEndpoint(output: string): string | null {
  try {
    const found = findEndpoint(JSON.parse(output))
    if (found) return found
  } catch {
    // not JSON, fall through
  }
  return output.match(ENDPOINT)?.[0] ?? null
}

function findEndpoint(value: unknown): string | null {
  if (typeof value === "string") return ENDPOINT.test(value) ? value.match(ENDPOINT)![0] : null
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findEndpoint(item)
      if (hit) return hit
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const hit = findEndpoint(item)
      if (hit) return hit
    }
  }
  return null
}

function run(bin: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, signal, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`clawctl ${args[0]} failed: ${(stderr || err.message).trim().slice(0, 300)}`))
      else resolve(stdout)
    })
  })
}

// Clawbrowser cold starts are heavy. Only a few profiles start at once.
const starts = new Semaphore(4)

export async function clawLaunch(options: ClawLaunchOptions): Promise<ClawBrowser> {
  const bin = options.clawctl ?? process.env.CLAWCTL_PATH ?? "clawctl"
  const timeoutMs = options.timeoutMs ?? 60_000
  const profile = profileName(options.profile)
  const url = options.url ?? "about:blank"

  const release = await starts.acquire(options.signal)
  let endpoint: string | null
  try {
    await run(bin, ["start", "--profile", profile, "--url", url, "--json"], timeoutMs, options.signal)
    endpoint = parseEndpoint(await run(bin, ["endpoint", "--profile", profile, "--json"], timeoutMs, options.signal))
  } finally {
    release()
  }
  if (!endpoint) throw new Error(`clawctl returned no CDP endpoint for profile ${profile}.`)

  const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs })
  const context = browser.contexts()[0] ?? (await browser.newContext())
  return {
    profile,
    endpoint,
    browser,
    context,
    async close(closeOptions) {
      await browser.close().catch(() => undefined)
      if (closeOptions?.stopProfile) await run(bin, ["stop", "--profile", profile, "--json"], timeoutMs).catch(() => undefined)
    }
  }
}
