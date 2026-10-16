export interface KeywordQuery {
  positive: string[]
  negative: string[]
}

/** `+elite +trainer +box -sleeves` or `"elite trainer box" -sleeves`. A leading + is optional. */
export function parseKeywordQuery(input: string): KeywordQuery {
  const positive: string[] = []
  const negative: string[] = []
  const re = /"([^"]+)"|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(input))) {
    const raw = (match[1] ?? match[2] ?? "").trim()
    if (!raw) continue
    if (raw.startsWith("-") && raw.length > 1) negative.push(raw.slice(1).toLowerCase())
    else {
      const word = raw.replace(/^\+/, "").toLowerCase()
      if (word) positive.push(word)
    }
  }
  return { positive, negative }
}

/** Empty input is not a keyword constraint. A non-empty query needs every positive term and no negative term. */
export function keywordsAllow(input: string, text: string): boolean {
  if (!input.trim()) return true
  const query = parseKeywordQuery(input)
  if (!query.positive.length) return false
  const hay = text.toLowerCase()
  if (query.negative.some((word) => hay.includes(word))) return false
  return query.positive.every((word) => hay.includes(word))
}

export function searchTerms(input: string): string {
  return parseKeywordQuery(input).positive.join(" ")
}
