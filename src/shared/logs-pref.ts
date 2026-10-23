/** Phone: logs stay collapsed unless the person opened them before. */
export const LOGS_PREF_KEY = "zzz-logs-open"

export function readLogsOpen(raw: string | null | undefined): boolean {
  return raw === "1"
}

export function writeLogsOpen(open: boolean): string {
  return open ? "1" : "0"
}

export function logsButtonLabel(open: boolean, count: number): string {
  return `${open ? "Hide logs" : "Logs"}${count ? ` (${count})` : ""}`
}
