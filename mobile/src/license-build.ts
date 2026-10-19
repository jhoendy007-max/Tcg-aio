declare const process: { env: Record<string, string | undefined> }

/** The release bundle keeps these so CI can see the baked license server. The phone still uses the paired PC's license. */
export function keepLicenseBuild(): void {
  const url = (process.env.EXPO_PUBLIC_TCGAIO_LICENSE_URL ?? "").trim().replace(/\/$/, "")
  const key = (process.env.EXPO_PUBLIC_TCGAIO_LICENSE_PUBLIC_KEY ?? "").trim()
  ;(globalThis as { __tcgaioLicenseBuild?: string }).__tcgaioLicenseBuild = `${url}\n${key}`
}
