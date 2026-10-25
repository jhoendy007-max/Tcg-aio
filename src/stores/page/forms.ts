import { isFinalSubmit } from "../../engine/test-mode"
import type { FullProfile, StoreId } from "../../shared/types"
import { hasAddControl } from "./parse"

export interface FormChoice {
  name: string
  value: string
  label: string
}

export interface StoreForm {
  action: string
  method: "GET" | "POST"
  kind: "cart" | "address" | "shipping" | "payment" | "token" | "place" | "remove"
  fields: { name: string; value: string }[]
  choices: FormChoice[]
}

export type BodyPlan =
  | { ok: true; fields: Record<string, string>; shipping: boolean }
  | { ok: false; reason: "pickup" | "no-card" }

const ADDRESS_EXACT = new Set([
  "firstname", "lastname", "address1", "address2", "addressline1", "addressline2",
  "line1", "line2", "street", "city", "postalcode", "zip", "zipcode", "phone", "email", "country",
  "shippingfirstname", "shippinglastname", "shippingaddress1", "shippingcity", "shippingzip"
])
const ADDRESS_SUFFIX = ["firstname", "lastname", "address1", "address2", "postalcode", "zipcode", "city", "phone", "email"]

/** An https URL on this store only. Client ids and other embedded credentials are removed. */
export function sameStoreUrl(base: string, raw: string, host: string): string | null {
  const text = raw.trim()
  if (!text || text.startsWith("#") || /^javascript:/i.test(text)) return null
  let url: URL
  try {
    url = new URL(text, base)
  } catch {
    return null
  }
  if (url.protocol !== "https:") return null
  if (url.username || url.password) return null
  const name = url.hostname.toLowerCase()
  if (name !== host.toLowerCase()) return null
  if (name === "ecom-api.costco.com" || name.includes("ecom-api")) return null
  for (const key of [...url.searchParams.keys()]) {
    if (isCredential(key)) url.searchParams.delete(key)
  }
  url.hash = ""
  return url.toString()
}

export function parseStoreForms(html: string, pageUrl: string, host: string, store: StoreId): StoreForm[] {
  const source = html.slice(0, 400_000)
  const forms: StoreForm[] = []
  for (const match of source.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const open = match[1] ?? ""
    const inner = (match[2] ?? "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    const method = attr(open, "method").toLowerCase() === "post" ? "POST" : "GET"
    let action = sameStoreUrl(pageUrl, attr(open, "action") || pageUrl, host)
    const fields: { name: string; value: string }[] = []
    const choices: FormChoice[] = []
    for (const input of inner.matchAll(/<input\b[^>]*>/gi)) {
      const tag = input[0]
      if (/\bdisabled\b/i.test(tag)) continue
      const name = attr(tag, "name")
      if (!name || isCredential(name)) continue
      const type = (attr(tag, "type") || "text").toLowerCase()
      if (type === "password" || type === "file") continue
      const value = attr(tag, "value")
      if (type === "radio" || type === "checkbox") {
        const label = attr(tag, "aria-label") || textAfter(inner, input.index ?? 0)
        choices.push({ name, value, label })
        if (/\bchecked\b/i.test(tag)) fields.push({ name, value })
        continue
      }
      if (type === "submit" || type === "button") {
        if (value) fields.push({ name, value })
        continue
      }
      fields.push({ name, value })
    }
    for (const button of inner.matchAll(/<button\b([^>]*)>[\s\S]*?<\/button>/gi)) {
      const tag = button[1] ?? ""
      if (/\bdisabled\b/i.test(tag)) continue
      const formaction = attr(tag, "formaction")
      if (formaction) {
        const next = sameStoreUrl(pageUrl, formaction, host)
        if (next) action = next
      }
      const name = attr(tag, "name")
      const value = attr(tag, "value")
      if (name && value && !isCredential(name)) fields.push({ name, value })
    }
    for (const select of inner.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = attr(select[1] ?? "", "name")
      if (!name || isCredential(name) || /\bdisabled\b/i.test(select[1] ?? "")) continue
      const options = [...(select[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)]
      let chosen = ""
      for (const option of options) {
        if (/\bdisabled\b/i.test(option[1] ?? "")) continue
        const value = attr(option[1] ?? "", "value")
        const label = stripTags(option[2] ?? "")
        choices.push({ name, value, label })
        if (!chosen || /\bselected\b/i.test(option[1] ?? "")) chosen = value
      }
      if (chosen) fields.push({ name, value: chosen })
    }
    if (!action) continue
    const kind = classify(store, method, action, inner, fields, choices)
    if (!kind) continue
    forms.push({ action, method, kind, fields, choices })
  }
  return forms
}

export function checkoutBody(input: {
  form: StoreForm
  mode: StoreForm["kind"]
  sku: string
  quantity: number
  profile: FullProfile
  requireSaved: boolean
}): BodyPlan {
  const fields = baseFields(input.form, input.mode === "token")
  const qty = Math.min(12, Math.max(1, Math.round(input.quantity) || 1))
  if (input.mode === "cart") {
    for (const field of input.form.fields) {
      const name = norm(field.name)
      if (name === "qty" || name.endsWith("quantity")) fields[field.name] = String(qty)
      if ((name === "pid" || name === "productid" || name === "sku" || name === "itemnumber") && !fields[field.name]) fields[field.name] = input.sku
    }
    return { ok: true, fields, shipping: false }
  }
  if (input.mode === "remove") return { ok: true, fields: baseFields(input.form, false), shipping: false }
  if (input.mode === "address") {
    fillAddress(fields, input.form, input.profile)
    const shipping = applyShipping(fields, input.form)
    if (shipping === "pickup") return { ok: false, reason: "pickup" }
    return { ok: true, fields, shipping: shipping === "set" }
  }
  if (input.mode === "shipping") {
    const shipping = applyShipping(fields, input.form)
    if (shipping === "pickup") return { ok: false, reason: "pickup" }
    return { ok: true, fields, shipping: true }
  }
  if (input.mode === "token") {
    const wrote = fillCard(fields, input.form, input.profile)
    if (!wrote) return { ok: false, reason: "no-card" }
    return { ok: true, fields, shipping: false }
  }
  const saved = savedCard(input.form, input.profile.last4)
  if (saved) fields[saved.name] = saved.value
  else if (input.requireSaved) return { ok: false, reason: "no-card" }
  return { ok: true, fields, shipping: false }
}

export function savedCard(form: StoreForm, last4: string): FormChoice | undefined {
  if (!/^\d{4}$/.test(last4)) return undefined
  const pattern = new RegExp(`\\b${last4}\\b`)
  return form.choices.find((choice) => pattern.test(`${choice.label} ${choice.value}`))
}

export function encodeFields(fields: Record<string, string>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) params.append(key, value)
  return params.toString()
}

export function readOrderId(body: string): string {
  const record = asRecord(safeJson(body))
  const order = asRecord(record?.order)
  const candidates = [record?.orderId, record?.orderNumber, record?.orderNo, order?.orderId, order?.orderNumber]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && safeOrderId(candidate)) return candidate
  }
  const match = body.match(/order(?:\s|-)?(?:number|id)\s*[#:=]?\s*([A-Za-z0-9-]{3,32})/i)
  if (match?.[1] && safeOrderId(match[1])) return match[1]
  return ""
}

export function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0] ?? ""
  return value ?? ""
}

function classify(
  store: StoreId,
  method: "GET" | "POST",
  action: string,
  inner: string,
  fields: { name: string }[],
  choices: FormChoice[]
): StoreForm["kind"] | null {
  if (method === "POST" && isFinalSubmit(store, { method: "POST", url: action })) return "place"
  const path = pathname(action)
  const cardField = fields.some((field) => isCardSecret(field.name))
  if (method === "POST" && /token/i.test(path) && cardField) return "token"
  if (method === "POST" && /(?:remove|delete)[-_/]?(?:product|item|line|from[-_]?cart)|cart[-_/]remove|removefromcart/i.test(path) && !/add/i.test(path)) return "remove"
  if (hasAddControl(inner) || /cart-addproduct|add-to-cart|addtocart|\/cart\/add/i.test(path)) return "cart"
  if (method !== "POST") return null
  if (addressCount(fields) >= 2) return "address"
  if (choices.some((choice) => /ship/i.test(choice.name))) return "shipping"
  if (cardField || choices.some((choice) => /card|visa|mastercard|amex|payment/i.test(`${choice.name} ${choice.label}`))) return "payment"
  return null
}

function baseFields(form: StoreForm, allowCard: boolean): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const field of form.fields) {
    if (isCredential(field.name)) continue
    if (!allowCard && isCardData(field.name)) continue
    fields[field.name] = field.value
  }
  return fields
}

function fillAddress(fields: Record<string, string>, form: StoreForm, profile: FullProfile): void {
  for (const field of form.fields) {
    const name = norm(field.name)
    const value = addressValue(name, profile)
    if (value !== undefined) fields[field.name] = value
  }
}

function addressValue(name: string, profile: FullProfile): string | undefined {
  if (!isAddressName(name) && !isStateName(name)) return undefined
  if (name.endsWith("firstname")) return profile.shipping.firstName
  if (name.endsWith("lastname")) return profile.shipping.lastName
  if (name.endsWith("address2") || name.endsWith("line2")) return profile.shipping.line2
  if (name.endsWith("address1") || name.endsWith("line1") || name === "street") return profile.shipping.line1
  if (name.endsWith("city")) return profile.shipping.city
  if (isStateName(name)) return profile.shipping.state
  if (name.endsWith("postalcode") || name.endsWith("zipcode") || name.endsWith("zip")) return profile.shipping.zip
  if (name.endsWith("phone")) return profile.phone
  if (name.endsWith("email")) return profile.email
  if (name === "country" || name.endsWith("country")) return "US"
  return undefined
}

function applyShipping(fields: Record<string, string>, form: StoreForm): "set" | "pickup" | "none" {
  const shipping = form.choices.filter((choice) => /ship/i.test(choice.name))
  if (!shipping.length) return "none"
  const home = shipping.find((choice) => !/pickup|bopis|in-?store/i.test(`${choice.label} ${choice.value}`))
  if (!home) return "pickup"
  fields[home.name] = home.value
  return "set"
}

function fillCard(fields: Record<string, string>, form: StoreForm, profile: FullProfile): boolean {
  let wrote = false
  for (const field of form.fields) {
    const name = norm(field.name)
    if (isCardSecret(field.name) && (name.endsWith("cardnumber") || name === "pan" || name.endsWith("ccnumber"))) {
      fields[field.name] = profile.card.number
      wrote = true
    } else if (name.endsWith("cvv") || name.endsWith("cvc") || name.endsWith("securitycode")) fields[field.name] = profile.card.cvv
    else if (name.endsWith("expmonth") || name.endsWith("expirationmonth") || name.endsWith("ccmonth")) fields[field.name] = profile.card.expMonth
    else if (name.endsWith("expyear") || name.endsWith("expirationyear") || name.endsWith("ccyear")) fields[field.name] = profile.card.expYear
    else if (name.endsWith("cardholdername") || name.endsWith("nameoncard") || name === "ccname") fields[field.name] = profile.card.name
  }
  return wrote
}

function addressCount(fields: { name: string }[]): number {
  return fields.filter((field) => isAddressName(norm(field.name)) || isStateName(norm(field.name))).length
}

function isAddressName(name: string): boolean {
  if (ADDRESS_EXACT.has(name)) return true
  return ADDRESS_SUFFIX.some((suffix) => name.endsWith(suffix))
}

function isStateName(name: string): boolean {
  return name === "state" || name.endsWith("statecode") || name.endsWith("shippingstate")
}

function isCredential(name: string): boolean {
  const text = norm(name)
  return text === "clientid" || text === "clientsecret" || text === "apikey" || text === "xapikey" || text === "authorization"
}

function isCardSecret(name: string): boolean {
  const text = norm(name)
  return text.endsWith("cardnumber") || text === "pan" || text.endsWith("ccnumber") || text.endsWith("cvv") || text.endsWith("cvc") || text.endsWith("securitycode")
}

function isCardData(name: string): boolean {
  const text = norm(name)
  return isCardSecret(name) || text.endsWith("expmonth") || text.endsWith("expirationmonth") || text.endsWith("expyear") || text.endsWith("expirationyear") || text.endsWith("cardholdername") || text.endsWith("nameoncard")
}

function safeOrderId(value: string): boolean {
  return /^[A-Za-z0-9-]{3,32}$/.test(value) && !/^\d{13,19}$/.test(value)
}

function pathname(action: string): string {
  try {
    return new URL(action).pathname
  } catch {
    return ""
  }
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "")
}

function attr(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"))
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim()
}

function textAfter(html: string, index: number): string {
  return stripTags(html.slice(index, index + 100))
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
}

function safeJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}
