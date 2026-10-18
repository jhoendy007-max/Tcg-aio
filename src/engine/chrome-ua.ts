/**
 * User-Agent aligned with the Chromium that this process actually is.
 * Electron sets `process.versions.chrome`. Outside Electron the version is unknown.
 */
export function chromeUserAgent(version = process.versions.chrome): string {
  const chrome = version && /^\d+(?:\.\d+){1,3}$/.test(version) ? version : "0.0.0.0"
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36`
}
