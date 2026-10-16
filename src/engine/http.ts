import { fetch as undiciFetch, ProxyAgent, type Dispatcher } from "undici"
import { proxyToUrl } from "../shared/proxy"
import type { ProxyEndpoint } from "../shared/types"

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  url: string
  headers?: Record<string, string>
  body?: string
  proxy?: ProxyEndpoint
  signal?: AbortSignal
  redirect?: "follow" | "manual"
  timeoutMs?: number
}

export interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface HttpClient {
  request(input: HttpRequest): Promise<HttpResponse>
}

const agents = new Map<string, Dispatcher>()

function agentFor(proxy?: ProxyEndpoint): Dispatcher | undefined {
  if (!proxy) return undefined
  const key = proxyToUrl(proxy)
  let agent = agents.get(key)
  if (!agent) {
    agent = new ProxyAgent(key)
    agents.set(key, agent)
  }
  return agent
}

export async function undiciRequest(input: HttpRequest): Promise<HttpResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 25000)
  const onAbort = () => controller.abort()
  input.signal?.addEventListener("abort", onAbort)
  try {
    const res = await undiciFetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      redirect: input.redirect ?? "follow",
      signal: controller.signal,
      dispatcher: agentFor(input.proxy)
    })
    const body = await res.text()
    const headers: Record<string, string | string[] | undefined> = {}
    res.headers.forEach((value, key) => {
      headers[key] = value
    })
    if (typeof res.headers.getSetCookie === "function") {
      const cookies = res.headers.getSetCookie()
      if (cookies.length) headers["set-cookie"] = cookies
    }
    return { status: res.status, headers, body }
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onAbort)
  }
}

export const defaultHttp: HttpClient = { request: undiciRequest }
