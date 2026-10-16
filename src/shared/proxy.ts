import type { ProxyEndpoint } from "./types"

export function parseProxyLine(line: string): ProxyEndpoint | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith("#")) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    let url: URL
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80))
    if (!url.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return {
      id: "",
      host: url.hostname,
      port,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      password: url.password ? decodeURIComponent(url.password) : undefined
    }
  }
  if (trimmed.includes("@")) {
    const at = trimmed.lastIndexOf("@")
    const cred = trimmed.slice(0, at)
    const hostport = trimmed.slice(at + 1)
    const colon = cred.indexOf(":")
    const hostSplit = hostport.split(":")
    if (colon < 1 || hostSplit.length !== 2) return null
    const port = Number(hostSplit[1])
    if (!hostSplit[0] || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return {
      id: "",
      host: hostSplit[0],
      port,
      username: cred.slice(0, colon),
      password: cred.slice(colon + 1)
    }
  }
  const parts = trimmed.split(":")
  if (parts.length === 2) {
    const port = Number(parts[1])
    if (!parts[0] || !Number.isInteger(port) || port < 1 || port > 65535) return null
    return { id: "", host: parts[0], port }
  }
  if (parts.length >= 4) {
    const port = Number(parts[1])
    if (!parts[0] || !Number.isInteger(port) || port < 1 || port > 65535 || !parts[2]) return null
    return {
      id: "",
      host: parts[0],
      port,
      username: parts[2],
      password: parts.slice(3).join(":")
    }
  }
  return null
}

export function parseProxyList(text: string): { proxies: ProxyEndpoint[]; skipped: string[] } {
  const proxies: ProxyEndpoint[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw || raw.startsWith("#")) continue
    const parsed = parseProxyLine(raw)
    if (!parsed) {
      skipped.push(raw)
      continue
    }
    const key = `${parsed.host}:${parsed.port}:${parsed.username ?? ""}:${parsed.password ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    proxies.push(parsed)
  }
  return { proxies, skipped }
}

export function formatProxy(proxy: ProxyEndpoint): string {
  if (proxy.username) return `${proxy.host}:${proxy.port}:${proxy.username}:${proxy.password ?? ""}`
  return `${proxy.host}:${proxy.port}`
}

export function proxyLabel(proxy: ProxyEndpoint): string {
  return `${proxy.host}:${proxy.port}`
}

export function proxyToUrl(proxy: ProxyEndpoint): string {
  const auth = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? "")}@`
    : ""
  return `http://${auth}${proxy.host}:${proxy.port}`
}
