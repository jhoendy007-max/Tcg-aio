export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "")
}

export function luhnOk(num: string): boolean {
  const digits = digitsOnly(num)
  if (!/^\d{13,19}$/.test(digits)) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i])
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

export function last4(num: string): string {
  const digits = digitsOnly(num)
  return digits.slice(-4)
}

export function normalizeExp(month: string, year: string): { expMonth: string; expYear: string } | null {
  const expMonth = digitsOnly(month)
  let expYear = digitsOnly(year)
  if (!/^\d{1,2}$/.test(expMonth) || !/^\d{2}$|^\d{4}$/.test(expYear)) return null
  const m = Number(expMonth)
  if (m < 1 || m > 12) return null
  if (expYear.length === 2) expYear = `20${expYear}`
  return { expMonth: String(m).padStart(2, "0"), expYear }
}

export function expiryInFuture(expMonth: string, expYear: string, now = new Date()): boolean {
  const normalized = normalizeExp(expMonth, expYear)
  if (!normalized) return false
  const end = new Date(Number(normalized.expYear), Number(normalized.expMonth), 1)
  return end > now
}
