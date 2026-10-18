import { compareVersions } from "./releases"
import type { ReleaseAsset, UpdateStatus } from "../shared/types"

export const DEV_DOWNLOAD_MESSAGE = "Install the Windows app to download an update. This check only reports that a release exists."
export const DEV_INSTALL_MESSAGE = "Install the Windows app to restart and install. Development builds cannot apply an update."

export function startChecking(status: UpdateStatus): UpdateStatus {
  return { ...status, status: "checking", error: "", percent: null }
}

/** A desktop update is available only when GitHub has a newer build with an installer. */
export function releaseDecision(status: UpdateStatus, release: Pick<ReleaseAsset, "version" | "notes" | "exe" | "apk"> | null, current: string): UpdateStatus {
  const version = release?.version ?? null
  const notes = release?.notes ?? ""
  const phoneVersion = release?.apk ? version : null
  const newer = Boolean(version && release?.exe && compareVersions(version, current) > 0)
  return {
    ...status,
    status: newer ? "available" : "current",
    version: newer ? version : current,
    notes,
    phoneVersion,
    error: "",
    percent: null
  }
}

export function startDownload(status: UpdateStatus, packaged: boolean): { status: UpdateStatus; proceed: boolean } {
  if (!packaged) {
    return { proceed: false, status: { ...status, status: "error", error: DEV_DOWNLOAD_MESSAGE, percent: null } }
  }
  if (status.status !== "available" && status.status !== "downloading") {
    return { proceed: false, status: { ...status, status: "error", error: "Check for an update before downloading.", percent: null } }
  }
  return { proceed: true, status: { ...status, status: "downloading", error: "", percent: status.percent ?? 0 } }
}

export function applyProgress(status: UpdateStatus, percent: number): UpdateStatus {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0
  return { ...status, status: "downloading", percent: value, error: "" }
}

export function markReady(status: UpdateStatus): UpdateStatus {
  return { ...status, status: "downloaded", error: "", percent: 100 }
}

export function markFailed(status: UpdateStatus, message: string): UpdateStatus {
  const text = redactToken(message).slice(0, 500) || "The update could not be downloaded."
  return { ...status, status: "error", error: text, percent: null }
}

export function canInstall(status: UpdateStatus, packaged: boolean): { ok: true } | { ok: false; status: UpdateStatus } {
  if (!packaged) return { ok: false, status: { ...status, status: "error", error: DEV_INSTALL_MESSAGE } }
  if (status.status !== "downloaded") {
    return { ok: false, status: { ...status, status: "error", error: "Download the update before restarting to install." } }
  }
  return { ok: true }
}

/** electron-updater demands a token whenever private is true, including on a public repo. */
export function feedPrivacy(token: string): { private: boolean; token?: string } {
  const trimmed = token.trim()
  if (!trimmed) return { private: false }
  return { private: true, token: trimmed }
}

export function redactToken(message: string): string {
  return message.replace(/github_pat_[A-Za-z0-9_]+/g, "[token]").replace(/gh[ps]_[A-Za-z0-9_]+/g, "[token]")
}
