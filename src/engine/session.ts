import { AppError } from "../shared/errors"
import type { SessionCookies } from "../shared/types"

export function parseSession(text: string): SessionCookies {
  const trimmed = text.trim()
  if (!trimmed) throw new AppError("Paste a browser session before saving.")
  if (trimmed.startsWith("{")) {
    let json: unknown
    try {
      json = JSON.parse(trimmed)
    } catch {
      throw new AppError("Session JSON could not be parsed.")
    }
    if (!json || typeof json !== "object") throw new AppError("Session JSON must be an object.")
    const record = json as Record<string, unknown>
    const accessToken = stringField(record, ["accessToken", "access_token", "auth"])
    if (!accessToken) throw new AppError("Session must include accessToken or auth.")
    return {
      accessToken,
      visitorId: stringField(record, ["visitorId", "visitorID", "visitor_id", "CID", "cid"]),
      refreshToken: stringField(record, ["refreshToken", "refresh_token"]),
      idToken: stringField(record, ["idToken", "id_token"]),
      cookie: stringField(record, ["cookie", "cookies"])
    }
  }
  const map = new Map<string, string>()
  for (const part of trimmed.split(/;\s*/)) {
    const eq = part.indexOf("=")
    if (eq <= 0) continue
    map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  const accessToken = map.get("accessToken") ?? map.get("access_token") ?? map.get("auth")
  if (!accessToken) throw new AppError("Session must include accessToken or auth.")
  return {
    accessToken,
    visitorId: map.get("visitorId") ?? map.get("visitorID") ?? map.get("visitor_id") ?? map.get("CID") ?? map.get("cid"),
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
