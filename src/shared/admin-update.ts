/** Pure decisions for the admin APK update. The phone UI and the server tests share this. */

export const APK_INSTALL_FLAGS = 1 | 0x10000000
export const ADMIN_PACKAGE = "com.tcgaio.admin"

export function installedVersionCode(nativeBuild: string | null | undefined, configCode: number | null | undefined): number {
  const native = Number(nativeBuild)
  if (Number.isInteger(native) && native > 0) return native
  const config = Number(configCode ?? 0)
  return Number.isInteger(config) && config > 0 ? config : 0
}

export function adminUpdateDecision(
  localCode: number,
  info: { available?: boolean; version?: string; versionCode?: number }
): { phase: "current"; message: string } | { phase: "missing"; message: string } | { phase: "available"; version: string; versionCode: number } {
  const remote = Number(info.versionCode ?? 0)
  if (info.available !== true || !Number.isInteger(remote) || remote < 1) {
    return { phase: "missing", message: "No admin update is on the server yet." }
  }
  if (remote <= localCode) return { phase: "current", message: "Up to date" }
  return { phase: "available", version: String(info.version ?? remote), versionCode: remote }
}

export function adminDownloadUrl(base: string, ticket: string): string {
  const url = new URL(`${base.replace(/\/$/, "")}/v1/admin/app/download`)
  url.searchParams.set("ticket", ticket)
  return url.toString()
}

/**
 * A ticket lets the downloader skip the Authorization header.
 * The live server answers 404 for this route until it is updated, and that must fall back to the session URL.
 * 401 means the admin session itself is gone.
 */
export function adminDownloadTarget(base: string, status: number, ticket: string | undefined): { kind: "auth" } | { kind: "url"; url: string } {
  const root = base.replace(/\/$/, "")
  if (status === 401) return { kind: "auth" }
  const token = (ticket ?? "").trim()
  if (status >= 200 && status < 300 && token) return { kind: "url", url: adminDownloadUrl(root, token) }
  return { kind: "url", url: `${root}/v1/admin/app/download` }
}

/** An automatic re-check must not wipe a download, an open installer, or an error the user has not dismissed. */
export function preserveUpdatePhase(phase: string): boolean {
  return phase === "downloading" || phase === "installing" || phase === "error"
}

export function downloadFailure(status: number, body: string, magicOk: boolean): string | null {
  if (status === 401) return "Sign in to the admin desk again."
  if (status !== 200) {
    const text = body.trim()
    if (text.startsWith("{")) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown }
        if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim()
      } catch {
        /* The body is not JSON. */
      }
    }
    if (text && !text.startsWith("PK")) return text.slice(0, 240)
    return `The download stopped (HTTP ${status}).`
  }
  if (!magicOk) return "The server did not return an APK file."
  return null
}

export function apkMagicOk(base64Head: string): boolean {
  return base64Head.startsWith("UEs")
}

/** RESULT_OK is -1. Anything else means the installer closed without installing. */
export function installerResultError(resultCode: number): string | null {
  if (resultCode === -1) return null
  return "The installer did not open. Allow this app to install unknown apps, then try again."
}

export function plainUpdateError(err: unknown): string {
  const message = err instanceof Error ? err.message : ""
  if (/401|sign in to the admin desk/i.test(message)) return "Sign in to the admin desk again."
  if (/unknown app|REQUEST_INSTALL_PACKAGES|INSTALL_PACKAGES|parse the package/i.test(message)) {
    return "Allow this app to install unknown apps, then try again."
  }
  const text = message.trim()
  return text || "The update could not be installed."
}
