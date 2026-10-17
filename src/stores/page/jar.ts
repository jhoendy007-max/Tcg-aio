import { cookieHeader } from "../../engine/challenge"
import type { HttpResponse } from "../../engine/http"
import type { SessionCookies } from "../../shared/types"

/** Cookies the user's browser or this store already set. Nothing here is forged. */
export class PageCookies {
  private cookies = new Map<string, string>()

  load(session?: SessionCookies): void {
    const header = cookieHeader(session)
    if (!header) return
    for (const part of header.split(/;\s*/)) {
      const eq = part.indexOf("=")
      if (eq <= 0) continue
      this.cookies.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
    }
  }

  absorb(headers: HttpResponse["headers"]): boolean {
    const value = headers["set-cookie"]
    const list = Array.isArray(value) ? value : value ? [value] : []
    let changed = false
    for (const cookie of list) {
      const pair = cookie.split(";")[0]?.trim() ?? ""
      const eq = pair.indexOf("=")
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const next = pair.slice(eq + 1).trim()
      if (this.cookies.get(name) !== next) {
        this.cookies.set(name, next)
        changed = true
      }
    }
    return changed
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ")
  }
}
