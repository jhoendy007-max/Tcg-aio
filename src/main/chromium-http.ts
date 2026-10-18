import { net, session, type Session } from "electron"
import { performance } from "node:perf_hooks"
import {
  chromiumTiming,
  cookieDiff,
  cookieWrites,
  planChromiumCall,
  toHttpHeaders,
  type StoredCookie
} from "../engine/chromium-session"
import { chromeUserAgent } from "../engine/chrome-ua"
import type { HttpClient, HttpRequest, HttpResponse } from "../engine/http"
import type { ProxyEndpoint } from "../shared/types"

const prepared = new Set<string>()
const proxyBound = new Map<string, string>()
const proxyGate = new Map<string, Promise<void>>()

/**
 * Store and monitor HTTP through the Chromium network stack Electron ships.
 * Each account uses persist:account-${id}. A monitor with no account uses an
 * in-memory partition for that proxy. Undici stays available for everything else.
 */
export const chromiumHttp: HttpClient = {
  request: chromiumRequest
}

async function chromiumRequest(input: HttpRequest): Promise<HttpResponse> {
  if (input.signal?.aborted) throw abortError()
  const started = performance.now()
  const plan = planChromiumCall(input)
  const browser = session.fromPartition(plan.partition)
  if (!prepared.has(plan.partition)) {
    prepared.add(plan.partition)
    browser.setUserAgent(chromeUserAgent(), "en-US,en")
  }
  await ensureProxy(browser, plan.partition, input.proxy)
  const existing = await readCookies(browser, input.url)
  await writeCookies(browser, input.url, cookieWrites(input.url, plan.cookies, existing))
  const baseline = (await readCookies(browser, input.url)).map((cookie) => ({ name: cookie.name, value: cookie.value }))
  const result = await exchange(browser, input, plan)
  const changed = cookieDiff(baseline, (await readCookies(browser, input.url)).map((cookie) => ({ name: cookie.name, value: cookie.value })))
  return {
    status: result.status,
    headers: toHttpHeaders(result.headers, changed),
    body: result.body,
    timing: chromiumTiming(started, result.headerAt, performance.now())
  }
}

async function readCookies(browser: Session, url: string): Promise<StoredCookie[]> {
  const cookies = await browser.cookies.get({ url })
  return cookies.map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    hostOnly: cookie.hostOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate
  }))
}

async function writeCookies(browser: Session, url: string, writes: ReturnType<typeof cookieWrites>): Promise<void> {
  await Promise.all(writes.map(async (cookie) => {
    try {
      await browser.cookies.set({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate
      })
    } catch {
      // A cookie the site already stored can still be sent. Skip one that Chromium rejects.
    }
  }))
}

function ensureProxy(browser: Session, partition: string, proxy?: ProxyEndpoint): Promise<void> {
  const key = proxy ? `${proxy.host}:${proxy.port}` : "direct"
  if (proxyBound.get(partition) === key) return Promise.resolve()
  const prev = proxyGate.get(partition) ?? Promise.resolve()
  const run = prev.then(async () => {
    if (proxyBound.get(partition) === key) return
    if (proxy) await browser.setProxy({ proxyRules: `http://${proxy.host}:${proxy.port};https://${proxy.host}:${proxy.port}` })
    else await browser.setProxy({ mode: "direct" })
    proxyBound.set(partition, key)
  })
  proxyGate.set(partition, run.then(() => undefined, () => undefined))
  return run
}

interface ExchangeResult {
  status: number
  headers: Record<string, string | string[]>
  body: string
  headerAt: number
}

function exchange(browser: Session, input: HttpRequest, plan: ReturnType<typeof planChromiumCall>): Promise<ExchangeResult> {
  return new Promise((resolve, reject) => {
    const request = net.request({
      method: input.method,
      url: input.url,
      session: browser,
      useSessionCookies: true,
      redirect: plan.redirect
    })
    for (const [name, value] of Object.entries(plan.headers)) request.setHeader(name, value)
    let settled = false
    let headerAt = performance.now()
    let cause: Error | null = null
    let redirect: { status: number; headers: Record<string, string[]> } | null = null
    let hops = 0
    const finish = (err: Error | null, value?: ExchangeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
      if (err) reject(err)
      else if (value) resolve(value)
    }
    const fail = (err: Error) => {
      if (!cause) cause = err
      try {
        request.abort()
      } catch {
        // The request already finished.
      }
      finish(cause)
    }
    const timer = setTimeout(() => fail(new Error("The request timed out.")), input.timeoutMs ?? 25_000)
    const onAbort = () => fail(abortError())
    if (input.signal) input.signal.addEventListener("abort", onAbort)
    request.on("login", (authInfo, callback) => {
      if (authInfo.isProxy && input.proxy?.username) {
        callback(input.proxy.username, input.proxy.password ?? "")
        return
      }
      callback()
    })
    request.on("redirect", (statusCode, _method, _redirectUrl, responseHeaders) => {
      headerAt = performance.now()
      if (plan.redirect === "manual") {
        redirect = { status: statusCode, headers: responseHeaders }
        return
      }
      hops += 1
      if (hops > 5) fail(new Error("Too many redirects."))
    })
    request.on("response", (response) => {
      headerAt = performance.now()
      readBody(response, input.signal).then(
        (body) => finish(null, { status: response.statusCode, headers: response.headers, body, headerAt }),
        (err) => finish(err instanceof Error ? err : new Error("The response could not be read."))
      )
    })
    request.on("error", (error) => {
      if (cause) {
        finish(cause)
        return
      }
      // Chromium cancels a manual redirect before it exposes that response body.
      // Status, location, and any cookie the session stored are still returned.
      if (redirect) {
        finish(null, { status: redirect.status, headers: redirect.headers, body: "", headerAt })
        return
      }
      if (input.signal?.aborted) {
        finish(abortError())
        return
      }
      finish(error)
    })
    if (input.body !== undefined) request.end(input.body)
    else request.end()
  })
}

function readBody(response: Electron.IncomingMessage, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on("data", (chunk) => chunks.push(chunk))
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    response.on("error", (error) => reject(error))
    response.on("aborted", () => reject(signal?.aborted ? abortError() : new Error("The response was aborted.")))
  })
}

function abortError(): Error {
  const err = new Error("The task was stopped.")
  err.name = "AbortError"
  return err
}
