/**
 * Countdown from an absolute timestamp.
 * The phone bundle can import src/shared. It cannot import src/engine.
 */
export function countdown(target: number, now: number): string {
  const delta = target - now
  if (delta <= 0) return "now"
  const total = Math.floor(delta / 1000)
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}
