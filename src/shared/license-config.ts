import { DEFAULT_LICENSE_SERVER_URL } from "./types"

/** Saved address, then the build-time address, then the public license server. */
export function licenseServerUrl(saved?: string): string {
  const chosen = (saved ?? "").trim() || (process.env.TCGAIO_LICENSE_URL ?? "").trim() || DEFAULT_LICENSE_SERVER_URL
  return chosen.replace(/\/$/, "")
}

/** Build-time Ed25519 public key. Empty means no grant can verify. */
export function licensePublicKey(): string {
  return (process.env.TCGAIO_LICENSE_PUBLIC_KEY ?? "").trim()
}
