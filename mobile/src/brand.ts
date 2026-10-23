/** User-visible app name and tagline. Package ids and file names stay "tcgaio" so updates keep working. */
export const APP_NAME = "Zzz AIO"
export const APP_TAGLINE = "Cop while you sleep"

/** Desktops before 0.2.38 report their brand as the old "TCGAIO"; show the current name instead. */
export function brandName(name: string | undefined | null): string {
  const clean = (name ?? "").trim()
  return !clean || /^tcg[\s-]?aio$/i.test(clean) ? APP_NAME : clean
}
