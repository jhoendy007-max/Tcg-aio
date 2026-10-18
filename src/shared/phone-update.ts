export type PhoneUpdatePhase = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error"

export interface PhoneUpdateState {
  phase: PhoneUpdatePhase
  current: string
  version: string | null
  notes: string
  apkName: string | null
  apkUrl: string | null
  percent: number | null
  error: string
}

export interface PhoneReleaseAsset {
  version: string
  tag: string
  notes: string
  apkName: string
  apkUrl: string
}

export function emptyPhoneUpdate(current: string): PhoneUpdateState {
  return { phase: "idle", current, version: null, notes: "", apkName: null, apkUrl: null, percent: null, error: "" }
}

export function startPhoneCheck(state: PhoneUpdateState): PhoneUpdateState {
  return { ...state, phase: "checking", error: "", percent: null }
}

/** Newest prerelease whose APK is newer than the installed phone build. */
export function decidePhoneUpdate(state: PhoneUpdateState, releases: PhoneReleaseAsset[], current: string): PhoneUpdateState {
  const newest = [...releases].sort((a, b) => compareRelease(b.version, a.version))[0] ?? null
  if (!newest || compareRelease(newest.version, current) <= 0) {
    return { ...state, phase: "current", current, version: current, notes: newest?.notes ?? "", apkName: null, apkUrl: null, percent: null, error: "" }
  }
  return {
    ...state,
    phase: "available",
    current,
    version: newest.version,
    notes: newest.notes,
    apkName: newest.apkName,
    apkUrl: newest.apkUrl,
    percent: null,
    error: ""
  }
}

export function startPhoneDownload(state: PhoneUpdateState): PhoneUpdateState {
  if (state.phase !== "available" && state.phase !== "downloading" && state.phase !== "ready") {
    return { ...state, phase: "error", error: "Check for an update before downloading." }
  }
  if (!state.apkUrl) return { ...state, phase: "error", error: "This release has no APK." }
  return { ...state, phase: "downloading", percent: 0, error: "" }
}

export function phoneDownloadProgress(state: PhoneUpdateState, percent: number): PhoneUpdateState {
  const value = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0
  return { ...state, phase: "downloading", percent: value, error: "" }
}

export function phoneUpdateReady(state: PhoneUpdateState): PhoneUpdateState {
  return { ...state, phase: "ready", percent: 100, error: "" }
}

export function phoneUpdateFailed(state: PhoneUpdateState, message: string): PhoneUpdateState {
  return { ...state, phase: "error", error: message.slice(0, 400) || "The update check failed.", percent: null }
}

export function phoneUpdateText(state: PhoneUpdateState): string {
  switch (state.phase) {
    case "idle":
      return "Not checked yet."
    case "checking":
      return "Checking for updates…"
    case "current":
      return `You are up to date (${state.current}).`
    case "available":
      return `Update ${state.version ?? ""} is available.`
    case "downloading":
      return `Downloading ${Math.round(state.percent ?? 0)}%.`
    case "ready":
      return `Update ${state.version ?? state.current} is ready to install.`
    case "error":
      return state.error || "The update check failed."
  }
}

export function readPhoneReleases(body: string): PhoneReleaseAsset[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const releases: PhoneReleaseAsset[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const row = item as { tag_name?: unknown; body?: unknown; name?: unknown; draft?: unknown; assets?: unknown }
    if (row.draft === true || typeof row.tag_name !== "string" || !/^v\d+\.\d+\.\d+/.test(row.tag_name)) continue
    const assets = Array.isArray(row.assets) ? row.assets : []
    const apk = assets.find((asset) => {
      if (!asset || typeof asset !== "object") return false
      const name = (asset as { name?: unknown }).name
      return typeof name === "string" && name.toLowerCase().endsWith(".apk")
    }) as { name: string; browser_download_url?: unknown } | undefined
    if (!apk) continue
    const url = typeof apk.browser_download_url === "string" ? apk.browser_download_url : ""
    if (!url.startsWith("https://")) continue
    releases.push({
      version: row.tag_name.replace(/^v/, ""),
      tag: row.tag_name,
      notes: typeof row.body === "string" ? row.body.slice(0, 4000) : typeof row.name === "string" ? row.name : "",
      apkName: apk.name,
      apkUrl: url
    })
  }
  return releases
}

/** 0.2.22 -> 222. Newer app versions get a higher Android versionCode. */
export function versionCodeFrom(version: string): number {
  const parts = versionParts(version)
  return (parts[0] ?? 0) * 10000 + (parts[1] ?? 0) * 100 + (parts[2] ?? 0)
}

export function expectedApkName(version: string): string {
  const match = version.match(/\d+(?:\.\d+){0,3}/)
  return `TCGAIO-Phone-${match ? match[0] : version}.apk`
}

function compareRelease(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

function versionParts(value: string): number[] {
  const match = value.match(/\d+(?:\.\d+){0,3}/)
  if (!match) return [0]
  return match[0].split(".").map((part) => Number(part))
}
