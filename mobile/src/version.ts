export const PHONE_VERSION = "0.2.14"

export function isNewer(latest: string | null, current: string): boolean {
  if (!latest) return false
  const parts = (value: string) => (value.match(/\d+(?:\.\d+){0,3}/)?.[0] ?? "0").split(".").map((part) => Number(part))
  const left = parts(latest)
  const right = parts(current)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0)
    if (delta !== 0) return delta > 0
  }
  return false
}
