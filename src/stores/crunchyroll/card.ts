export interface StripeCard {
  number: string
  cvc: string
  expMonth: string
  expYear: string
  name: string
  line1: string
  city: string
  state: string
  postalCode: string
}

export interface StripePaymentMethod {
  id: string
  brand: string
  last4: string
  expMonth: number
  expYear: number
}

/** Stripe PaymentMethod form body. The card number is sent only to api.stripe.com. */
export function stripePaymentMethodBody(card: StripeCard): string {
  const params = new URLSearchParams()
  params.set("type", "card")
  params.set("card[number]", card.number.replace(/\D/g, ""))
  params.set("card[exp_month]", String(Number(card.expMonth)))
  params.set("card[exp_year]", card.expYear.replace(/\D/g, ""))
  params.set("card[cvc]", card.cvc)
  params.set("billing_details[name]", card.name)
  params.set("billing_details[address][line1]", card.line1)
  params.set("billing_details[address][city]", card.city)
  params.set("billing_details[address][state]", card.state)
  params.set("billing_details[address][postal_code]", card.postalCode)
  params.set("billing_details[address][country]", "US")
  return params.toString()
}

export function readPaymentMethod(body: string): StripePaymentMethod | undefined {
  const record = asRecord(safeJson(body))
  const id = typeof record?.id === "string" ? record.id : ""
  if (!id.startsWith("pm_")) return undefined
  const card = asRecord(record?.card) ?? {}
  const brand = typeof card.brand === "string" ? card.brand : "unknown"
  const last4 = typeof card.last4 === "string" ? card.last4 : ""
  const expMonth = typeof card.exp_month === "number" ? card.exp_month : Number(card.exp_month)
  const expYear = typeof card.exp_year === "number" ? card.exp_year : Number(card.exp_year)
  if (!last4 || !Number.isFinite(expMonth) || !Number.isFinite(expYear)) return undefined
  return { id, brand, last4, expMonth, expYear }
}

export function commerceCardType(number: string): string {
  const digits = number.replace(/\D/g, "")
  if (digits.startsWith("34") || digits.startsWith("37")) return "Amex"
  if (digits.startsWith("4")) return "Visa"
  if (digits.startsWith("5")) return "MasterCard"
  if (digits.startsWith("6")) return "Discover"
  return "Visa"
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
