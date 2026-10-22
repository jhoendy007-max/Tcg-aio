export const UPDATE_CHECK_MS = 30 * 60 * 1000

const RUNNING = new Set(["monitoring", "in_stock", "adding_to_cart", "checking_out", "in_queue"])

export function tasksAreRunning(tasks: { status?: string }[]): boolean {
  return tasks.some((task) => RUNNING.has(task.status ?? ""))
}

export function promptVisible(status: string, later: boolean): boolean {
  if (later) return false
  return status === "available" || status === "downloading" || status === "downloaded" || status === "ready"
}

export function shortenNotes(notes: string, max = 500): string {
  const text = notes.replace(/\r/g, "").trim()
  if (!text) return "A new version is available."
  if (text.length <= max) return text
  return `${text.slice(0, max).trim()}…`
}

export function updateInstallLabel(status: string, percent: number | null): string {
  if (status === "downloading") return `Downloading ${Math.round(percent ?? 0)}%`
  if (status === "downloaded" || status === "ready") return "Install now"
  return "Install now"
}

export function runningTaskWarning(): string {
  return "Tasks are running. Installing stops them. You can install when they finish."
}
