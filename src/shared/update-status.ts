import type { UpdateStatus } from "./types"

export function updateStatusText(status: UpdateStatus): string {
  switch (status.status) {
    case "idle":
      return "Not checked yet."
    case "checking":
      return "Checking for updates…"
    case "current":
      return `You are up to date (${status.current}).`
    case "available":
      return `Update ${status.version ?? ""} is available.`
    case "downloading":
      return `Downloading ${Math.round(status.percent ?? 0)}%.`
    case "downloaded":
      return `Update ${status.version ?? status.current} is ready. Restart and install.`
    case "error":
      return status.error || "The update check failed."
  }
}
