import { net, session, type Session } from "electron"
import { performance } from "node:perf_hooks"
import {
  chromiumCallOptions,
  chromiumProxyRules,
  chromiumTiming,
  classifyProxyLogin,
  cookieDiff,
  cookieWrites,
  plainNetworkError,
  planChromiumCall,
  STOCK_CHECK_TIMEOUT,
  toHttpHeaders,
  type StoredCookie
} from "../engine/chromium-session"
import { chromeUserAgent } from "../engine/chrome-ua"
import type { HttpClient, HttpRequest, HttpResponse } from "../engine/http"
import type { ProxyEndpoint } from "../shared/types"

const prepared = new Set<string>()
const proxyBound = new Map<string, string>()
const proxyGate = new Map<string, Promise<void>>()

/** A sign-in window changed this partition's proxy. Re-apply the real one before the next request. */
export function forgetProxyBinding(partition: string): void {
  proxyBound.delete(partition)
}

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
  const timeoutMs = input.timeoutMs ?? 25_000
  const clock = new AbortController()
  const timer = setTimeout(() => clock.abort(), timeoutMs)
  const onUser = () => clock.abort()
  input.signal?.addEventListener("abort", onUser)
  const userAborted = () => Boolean(input.signal?.aborted)
  try {
    await ensureProxy(browser, plan.partition, input.proxy, clock.signal, userAborted)
    const existing = await untilAbort(readCookies(browser, input.url), clock.signal, userAborted)
    await untilAbort(writeCookies(browser, input.url, cookieWrites(input.url, plan.cookies, existing)), clock.signal, userAborted)
    const baseline = (await untilAbort(readCookies(browser, input.url), clock.signal, userAborted)).map((cookie) => ({ name: cookie.name, value: cookie.value }))
    const result = await exchange(browser, input, plan, clock.signal, userAborted)
    const changed = cookieDiff(baseline, (await untilAbort(readCookies(browser, input.url), clock.signal, userAborted)).map((cookie) => ({ name: cookie.name, value: cookie.value })))
    return {
      status: result.status,
      headers: toHttpHeaders(result.headers, changed),
      body: result.body,
      timing: chromiumTiming(started, result.headerAt, performance.now())
    }
  } catch (err) {
    if (userAborted()) throw abortError()
    throw plainNetworkError(err)
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener("abort", onUser)
  }
}

function untilAbort<T>(work: Promise<T>, signal: AbortSignal, userAborted: () => boolean): Promise<T> {
  if (signal.aborted) return Promise.reject(userAborted() ? abortError() : new Error(STOCK_CHECK_TIMEOUT))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(userAborted() ? abortError() : new Error(STOCK_CHECK_TIMEOUT))
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener("abort", onAbort)
        reject(err)
      }
    )
  })
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

function ensureProxy(
  browser: Session,
  partition: string,
  proxy: ProxyEndpoint | undefined,
  signal: AbortSignal,
  userAborted: () => boolean
): Promise<void> {
  const key = proxy ? `${proxy.host}:${proxy.port}` : "direct"
  if (proxyBound.get(partition) === key) return Promise.resolve()
  const prev = proxyGate.get(partition) ?? Promise.resolve()
  const run = new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      if (err) reject(err)
      else resolve()
    }
    const onAbort = () => finish(userAborted() ? abortError() : new Error(STOCK_CHECK_TIMEOUT))
    if (signal.aborted) {
      finish(userAborted() ? abortError() : new Error(STOCK_CHECK_TIMEOUT))
      return
    }
    signal.addEventListener("abort", onAbort)
    prev.then(async () => {
      if (signal.aborted || proxyBound.get(partition) === key) return
      if (proxy) await browser.setProxy({ proxyRules: chromiumProxyRules(proxy) })
      else await browser.setProxy({ mode: "direct" })
      if (signal.aborted) return
      proxyBound.set(partition, key)
    }).then(
      () => finish(),
      (err) => finish(err instanceof Error ? err : new Error("Proxy failed."))
    )
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

function exchange(
  browser: Session,
  input: HttpRequest,
  plan: ReturnType<typeof planChromiumCall>,
  clock: AbortSignal,
  userAborted: () => boolean
): Promise<ExchangeResult> {
  return new Promise((resolve, reject) => {
    const call = chromiumCallOptions(plan.redirect)
    const request = net.request({
      method: input.method,
      url: input.url,
      session: browser,
      redirect: call.redirect,
      referrerPolicy: call.referrerPolicy,
      useSessionCookies: call.useSessionCookies
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
      clock.removeEventListener("abort", onAbort)
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
    const onAbort = () => fail(userAborted() ? abortError() : new Error(STOCK_CHECK_TIMEOUT))
    clock.addEventListener("abort", onAbort)
    request.on("login", (authInfo, callback) => {
      const kind = classifyProxyLogin(authInfo, input.proxy)
      if (kind === "credentials" && input.proxy?.username) {
        callback(input.proxy.username, input.proxy.password ?? "")
        return
      }
      if (kind === "missing") {
        cause = new Error("Proxy failed. This proxy asked for a username and password.")
        callback()
        fail(cause)
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
      readBody(response, userAborted).then(
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
      if (userAborted()) {
        finish(abortError())
        return
      }
      finish(plainNetworkError(error))
    })
    if (clock.aborted) {
      fail(userAborted() ? abortError() : new Error(STOCK_CHECK_TIMEOUT))
      return
    }
    if (input.body !== undefined) request.end(input.body)
    else request.end()
  })
}

function readBody(response: Electron.IncomingMessage, userAborted: () => boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    response.on("data", (chunk) => chunks.push(chunk))
    response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    response.on("error", (error) => reject(plainNetworkError(error)))
    response.on("aborted", () => reject(userAborted() ? abortError() : new Error(STOCK_CHECK_TIMEOUT)))
  })
}

function abortError(): Error {
  const err = new Error("The task was stopped.")
  err.name = "AbortError"
  return err
}
