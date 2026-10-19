/** Build-time license server. Empty until the owner sets TCGAIO_LICENSE_URL and rebuilds. */
export function licenseServerUrl(): string {
  return (process.env.TCGAIO_LICENSE_URL ?? "").trim().replace(/\/$/, "")
}

/** Build-time Ed25519 public key. Empty means no grant can verify. */
export function licensePublicKey(): string {
  return (process.env.TCGAIO_LICENSE_PUBLIC_KEY ?? "").trim()
}
