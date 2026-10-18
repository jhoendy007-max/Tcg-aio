import type { HttpClient } from "./http"
import type { ReleaseAsset } from "../shared/types"
import { RELEASE_OWNER, RELEASE_REPO } from "../shared/version"

export function versionParts(value: string): number[] {
  const match = value.match(/\d+(?:\.\d+){0,3}/)
  if (!match) return [0]
  return match[0].split(".").map((part) => Number(part))
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0)
    if (delta !== 0) return delta > 0 ? 1 : -1
  }
  return 0
}

export function readReleases(body: string): ReleaseAsset[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const releases: ReleaseAsset[] = []
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue
    const row = item as { tag_name?: unknown; name?: unknown; body?: unknown; draft?: unknown; assets?: unknown }
    if (row.draft === true || typeof row.tag_name !== "string") continue
    const tag = row.tag_name
    if (!/^v\d+\.\d+\.\d+/.test(tag)) continue
    const assets = Array.isArray(row.assets) ? row.assets : []
    const names = assets.flatMap((asset) => (asset && typeof asset === "object" && typeof (asset as { name?: unknown }).name === "string" ? [(asset as { name: string }).name] : []))
    releases.push({
      version: tag.replace(/^v/, ""),
      tag,
      notes: typeof row.body === "string" ? row.body.slice(0, 4000) : typeof row.name === "string" ? row.name : "",
      exe: names.find((name) => name.toLowerCase().endsWith(".exe")) ?? null,
      apk: names.find((name) => name.toLowerCase().endsWith(".apk")) ?? null
    })
  }
  return releases
}

export function pickRelease(releases: ReleaseAsset[]): ReleaseAsset | null {
  const usable = releases.filter((release) => release.exe || release.apk)
  usable.sort((a, b) => compareVersions(b.version, a.version))
  return usable[0] ?? null
}

export const PRIVATE_RELEASE_MESSAGE = `This GitHub repo looks private. Save a token with Contents: Read on ${RELEASE_OWNER}/${RELEASE_REPO}. It stays on this PC.`

export async function fetchLatestRelease(http: HttpClient, token: string): Promise<ReleaseAsset | null> {
  const trimmed = token.trim()
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "TCGAIO"
  }
  if (trimmed) headers.authorization = `Bearer ${trimmed}`
  const response = await http.request({
    method: "GET",
    url: `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases?per_page=10`,
    headers,
    timeoutMs: 15000
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error(trimmed ? "GitHub rejected the token. It needs Contents: Read on this repo's releases." : PRIVATE_RELEASE_MESSAGE)
  }
  if (response.status < 200 || response.status >= 300) throw new Error(`GitHub returned HTTP ${response.status}.`)
  return pickRelease(readReleases(response.body))
}
