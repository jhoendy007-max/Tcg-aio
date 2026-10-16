export function parseTcin(input: string): string | null {
  const text = input.trim()
  const fromPath = text.match(/\/A-(\d{5,10})(?:\D|$)/i)
  if (fromPath) return fromPath[1]
  const fromQuery = text.match(/[?&]tcin=(\d{5,10})(?:\D|$)/i)
  if (fromQuery) return fromQuery[1]
  if (/^\d{5,10}$/.test(text)) return text
  return null
}
