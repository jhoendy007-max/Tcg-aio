const IMAGE_KEY = /image|img|picture|thumbnail|photo/i

/** An https image URL already present in a store product payload. */
export function httpsImage(value: unknown, depth = 0): string {
  if (depth > 5 || value == null) return ""
  if (typeof value === "string") return imageUrl(value)
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = httpsImage(item, depth + 1)
      if (found) return found
    }
    return ""
  }
  if (typeof value !== "object") return ""
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!IMAGE_KEY.test(key)) continue
    const direct = typeof record[key] === "string" ? imageUrl(record[key]) : httpsImage(record[key], depth + 1)
    if (direct) return direct
  }
  for (const key of Object.keys(record)) {
    const child = record[key]
    if (!child || typeof child !== "object") continue
    const found = httpsImage(child, depth + 1)
    if (found) return found
  }
  return ""
}

/** Image from a product JSON body or an og:image tag on a product page. */
export function productImage(body: string): string {
  const trimmed = body.trimStart()
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return httpsImage(JSON.parse(trimmed) as unknown)
    } catch {
      return ""
    }
  }
  const meta = body.match(/<meta[^>]+property=["']og:image["'][^>]*>/i) ?? body.match(/<meta[^>]+name=["']og:image["'][^>]*>/i)
  const content = meta?.[0]?.match(/content=["'](https:[^"']+)["']/i)
  return content?.[1] ? imageUrl(content[1]) : ""
}

function imageUrl(value: string): string {
  const url = value.trim()
  if (url.length > 400 || !/^https:\/\/[^\s]+$/i.test(url)) return ""
  return url
}
