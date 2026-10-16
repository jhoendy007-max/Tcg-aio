export function redact(text: string): string {
  return text
    .replace(/\b\d{13,19}\b/g, "[card]")
    .replace(/("cvv"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/("password"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/("card_number"\s*:\s*")[^"]*(")/gi, "$1[redacted]$2")
    .replace(/(accessToken=)[^;\s]+/gi, "$1[redacted]")
    .replace(/(refreshToken=)[^;\s]+/gi, "$1[redacted]")
    .replace(/(idToken=)[^;\s]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, "$1[redacted]")
}
