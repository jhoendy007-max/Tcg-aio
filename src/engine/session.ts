import { AppError } from "../shared/errors"
import type { SessionCookies } from "../shared/types"

export function parseSession(text: string): SessionCookies {
  const trimmed = text.trim()
  if (!trimmed) throw new AppError("Paste a browser session before saving.")
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    return { accessToken: trimmed }
  }
  if (trimmed.startsWith("{")) {
    let json: unknown
    try {
      json = JSON.parse(trimmed)
    } catch {
      throw new AppError("Session JSON could not be parsed.")
    }
    if (!json || typeof json !== "object") throw new AppError("Session JSON must be an object.")
    const record = json as Record<string, unknown>
    const accessToken = stringField(record, ["accessToken", "access_token", "auth", "at"])
    const cookie = stringField(record, ["cookie", "cookies"])
    if (!accessToken) {
      if (cookie) return parseSession(cookie)
      throw new AppError("Session must include accessToken, auth, a Best Buy at cookie, or a full cookie header.")
    }
    return {
      accessToken,
      visitorId: stringField(record, ["visitorId", "visitorID", "visitor_id", "CID", "cid", "vt"]),
      refreshToken: stringField(record, ["refreshToken", "refresh_token"]),
      idToken: stringField(record, ["idToken", "id_token"]),
      cookie
    }
  }
  const map = new Map<string, string>()
  for (const part of trimmed.split(/;\s*/)) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  const accessToken = map.get("accessToken") ?? map.get("access_token") ?? map.get("auth") ?? map.get("at")
  if (!accessToken) {
    if (map.size >= 2) {
      return {
        accessToken: "session",
        visitorId: map.get("visitorId") ?? map.get("visitorID") ?? map.get("visitor_id") ?? map.get("CID") ?? map.get("cid") ?? map.get("vt"),
        refreshToken: map.get("refreshToken") ?? map.get("refresh_token"),
        idToken: map.get("idToken") ?? map.get("id_token"),
        cookie: trimmed
      }
    }
    throw new AppError("Session must include accessToken, auth, a Best Buy at cookie, or a full cookie header.")
  }
  return {
    accessToken,
    visitorId: map.get("visitorId") ?? map.get("visitorID") ?? map.get("visitor_id") ?? map.get("CID") ?? map.get("cid") ?? map.get("vt"),
    refreshToken: map.get("refreshToken") ?? map.get("refresh_token"),
    idToken: map.get("idToken") ?? map.get("id_token"),
    cookie: trimmed.includes(";") ? trimmed : undefined
  }
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}
