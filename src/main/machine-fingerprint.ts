import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { hostname } from "node:os"
import { fingerprintHash } from "../shared/license-proof"

let cached = ""

/** Stable hash of this PC. Raw hardware ids stay on the machine. */
export function machineFingerprint(): string {
  if (cached) return cached
  const parts: string[] = []
  if (process.platform === "win32") {
    parts.push(regValue("HKLM\\SOFTWARE\\Microsoft\\Cryptography", "MachineGuid"))
    parts.push(powershell("(Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID"))
  } else {
    for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      try { parts.push(readFileSync(file, "utf8")) } catch { /* this path is optional */ }
    }
  }
  if (!parts.some((part) => part.trim())) parts.push(`host:${hostname()}`)
  cached = fingerprintHash(parts)
  return cached
}

function regValue(key: string, name: string): string {
  try {
    const output = execFileSync("reg", ["query", key, "/v", name], { encoding: "utf8", timeout: 4000, windowsHide: true })
    return output.split(/\s+/).filter(Boolean).at(-1) ?? ""
  } catch {
    return ""
  }
}

function powershell(command: string): string {
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8", timeout: 8000, windowsHide: true }).trim()
  } catch {
    return ""
  }
}
