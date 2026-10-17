export type AmazonStockStatus = "IN_STOCK" | "OUT_OF_STOCK" | "ABOVE_PRICE" | "NOT_FOUND"

export interface AmazonOffer {
  seller: string
  shipsFrom: string
  merchantId?: string
  fulfilledByAmazon: boolean
  price?: number
  offerListingId?: string
  csrf?: string
  asin?: string
  amazonRetail: boolean
  buyable: boolean
}

export interface StockReading {
  inStock: boolean
  status: AmazonStockStatus
  title?: string
  asin: string
  price?: number
  listPrice?: number
  offerListingId?: string
  csrf?: string
  seller?: string
  reason: string
  imageUrl?: string
}

export interface PlaceOrderForm {
  action: string
  fields: Record<string, string>
}

/** Amazon.com retail seller. The same id is also the marketplace id, so it only counts on an offer. */
export const AMAZON_RETAIL_ID = "ATVPDKIKX0DER"
const NEAR_LIST = 1.05

const ASIN_RE = /^[A-Z0-9]{10}$/i

export function parseAsin(input: string): string | null {
  const text = input.trim()
  if (ASIN_RE.test(text)) return text.toUpperCase()
  const match = text.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/offer-listing\/|[?&]asin=)([A-Z0-9]{10})(?=[/?#&]|$)/i)
  return match ? match[1].toUpperCase() : null
}

export function productUrl(asin: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(asin)}`
}

export function offersUrl(asin: string): string {
  return `https://www.amazon.com/gp/product/ajax/aodAjaxMain/ref=dp_aod_NEW_mbc?asin=${encodeURIComponent(asin)}&pc=dp`
}

export function isSignedInCookie(cookie?: string): boolean {
  if (!cookie) return false
  return /(?:^|;\s*)(?:at-main|sess-at-main)=/i.test(cookie)
}

export function isChallenge(status: number, body: string, location = ""): boolean {
  const target = `${location}\n${body.slice(0, 20000)}`.toLowerCase()
  if (target.includes("validatecaptcha") || target.includes("opfcaptcha") || target.includes("/errors/validatecaptcha")) return true
  if (target.includes("not a robot") || target.includes("enter the characters you see") || target.includes("type the characters you see")) return true
  if (target.includes("to discuss automated access to amazon data")) return true
  if (/<title>[^<]*robot check/i.test(body)) return true
  if (status === 503 && target.includes("captcha") && !target.includes("producttitle")) return true
  return false
}

export function isTwoFactor(body: string, location = ""): boolean {
  const target = `${location}\n${body.slice(0, 12000)}`.toLowerCase()
  if (target.includes("/ap/mfa") || target.includes("/ap/cvf")) return true
  if (target.includes("two-step verification") || target.includes("auth-mfa-otpcode")) return true
  if (target.includes("enter otp") || target.includes("approve the notification")) return true
  return false
}

export function isSignIn(body: string, location = ""): boolean {
  if (/\/ap\/signin/i.test(location)) return true
  if (/<form[^>]*name="signIn"/i.test(body)) return true
  if (/<title>[^<]*amazon sign-in/i.test(body)) return true
  return false
}

export function readStock(productHtml: string, offersHtml: string, asin: string): StockReading {
  const title = readTitle(productHtml)
  const listPrice = readListPrice(productHtml)
  const missing = isNotFound(productHtml) && !/aod-offer-soldBy/i.test(offersHtml)
  if (missing) return { inStock: false, status: "NOT_FOUND", asin, title, reason: `Amazon did not find ${asin}.` }
  let offers = readOffers(offersHtml)
  if (!offers.length) {
    const box = readBuyBox(productHtml, asin)
    if (box) offers = [box]
  }
  const label = title ?? `ASIN ${asin}`
  const amazon = offers.filter((offer) => offer.amazonRetail && offer.buyable && offer.price !== undefined && offer.offerListingId)
  if (!amazon.length) {
    const waiting = offers.find((offer) => offer.amazonRetail)
    if (waiting) {
      return {
        inStock: false,
        status: "OUT_OF_STOCK",
        title,
        asin,
        listPrice,
        seller: "Amazon.com",
        reason: `${label} is sold by Amazon.com and is currently unavailable.`
      }
    }
    const other = offers.find((offer) => offer.seller && offer.price !== undefined)
    const extra = other ? ` Lowest other offer is $${other.price!.toFixed(2)} from ${other.seller}.` : ""
    return {
      inStock: false,
      status: "OUT_OF_STOCK",
      title,
      asin,
      listPrice,
      reason: `${label} has no offer sold and shipped by Amazon.com.${extra}`
    }
  }
  const choice = amazon.reduce((best, offer) => (offer.price! < best.price! ? offer : best))
  if (listPrice !== undefined && choice.price! > listPrice * NEAR_LIST + 0.009) {
    return {
      inStock: false,
      status: "ABOVE_PRICE",
      title,
      asin,
      price: choice.price,
      listPrice,
      offerListingId: choice.offerListingId,
      seller: "Amazon.com",
      reason: `${label} from Amazon.com is $${choice.price!.toFixed(2)}, above the $${listPrice.toFixed(2)} list price.`
    }
  }
  return {
    inStock: true,
    status: "IN_STOCK",
    title,
    asin,
    price: choice.price,
    listPrice,
    offerListingId: choice.offerListingId,
    csrf: choice.csrf,
    seller: "Amazon.com",
    reason: `${label} is sold and shipped by Amazon.com at $${choice.price!.toFixed(2)}.`
  }
}

export function readOffers(html: string): AmazonOffer[] {
  const chunks: string[] = []
  const parts = html.split(/<div id="aod-offer"/i)
  if (/AodAddToCart|aod-offer-soldBy/i.test(parts[0] ?? "")) chunks.push(parts[0])
  for (const part of parts.slice(1)) chunks.push(part)
  const offers: AmazonOffer[] = []
  for (const chunk of chunks) {
    const offer = offerFrom(chunk)
    if (offer) offers.push(offer)
  }
  return offers
}

export function readBuyBox(html: string, asin: string): AmazonOffer | null {
  const merchantId = html.match(/id="merchantID"[^>]*value="([^"]*)"/i)?.[1] || undefined
  const seller = clean(html.match(/id=['"]sellerProfileTriggerId['"][^>]*>([^<]+)/i)?.[1] ?? "")
  if (!seller && merchantId !== AMAZON_RETAIL_ID) return null
  const priceText = html.match(/id="apex-pricetopay-accessibility-label"[^>]*>\s*\$([0-9,]+\.\d{2})/i)?.[1]
  const price = priceText ? money(priceText) : undefined
  const offerListingId = html.match(/name="items\[0\.base\]\[offerListingId\]" value="([^"]+)"/i)?.[1]
  const csrf = html.match(/name="anti-csrftoken-a2z" value="([^"]+)"/i)?.[1]
  const availability = html.match(/id="availability"[\s\S]{0,400}/i)?.[0]?.replace(/<[^>]+>/g, " ") ?? ""
  const unavailable = /currently unavailable|temporarily out of stock|out of stock/i.test(availability)
  const inStock = /in stock|only \d+ left|pre-order/i.test(availability)
  const name = seller || "Amazon.com"
  const shipsFrom = amazonName(name) ? "Amazon.com" : name
  return {
    seller: name,
    shipsFrom,
    merchantId,
    fulfilledByAmazon: false,
    price,
    offerListingId,
    csrf,
    asin,
    amazonRetail: isAmazonRetail(name, shipsFrom, merchantId, false),
    buyable: Boolean(offerListingId) && Boolean(price) && inStock && !unavailable
  }
}

export function readListPrice(html: string): number | undefined {
  const match = html.match(/List Price:\s*(?:<[^>]*>\s*){0,6}\$?\s*([0-9,]+\.\d{2})/i)
  return match ? money(match[1]) : undefined
}

export function readTitle(html: string): string | undefined {
  const title = html.match(/id="productTitle"[^>]*>\s*([^<]+)/i)?.[1]
  const cleaned = title ? clean(title) : ""
  return cleaned || undefined
}

export function asksForCard(body: string): boolean {
  const lower = body.toLowerCase()
  const saved = /ending in \d{3,4}/.test(lower) || lower.includes("gift card balance")
  const asks = lower.includes("add a credit or debit card") || lower.includes('name="addcreditcardnumber"') || lower.includes('name="ppw-accountnumber"')
  return asks && !saved
}

export function asksForCvv(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes('name="cvv"') || lower.includes('name="cvc"') || lower.includes("enter the security code") || lower.includes("confirm your card security")
}

export function pickupOnly(body: string): boolean {
  const lower = body.toLowerCase()
  const pickup = lower.includes("amazon locker") || lower.includes("amazon hub counter") || lower.includes("pickup location")
  const shipping = lower.includes("shipping address") || lower.includes("ship to") || lower.includes("deliver to")
  return pickup && !shipping
}

export interface OtpForm {
  action: string
  field: string
  fields: Record<string, string>
}

/** An OTP form the store already rendered. A captcha form is not an OTP form. */
export function readOtpForm(body: string): OtpForm | undefined {
  const forms = [...body.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)]
  for (const form of forms) {
    const attrs = form[1] ?? ""
    const inner = form[2] ?? ""
    const action = decode(attrs.match(/action="([^"]+)"/i)?.[1] ?? "")
    if (!action || /captcha|validatecaptcha/i.test(`${action}\n${inner}`)) continue
    const fields: Record<string, string> = {}
    let field = ""
    for (const input of inner.matchAll(/<input\b([^>]*)>/gi)) {
      const tag = input[1] ?? ""
      const name = decode(tag.match(/name="([^"]+)"/i)?.[1] ?? "")
      if (!name) continue
      const type = (tag.match(/type="([^"]+)"/i)?.[1] ?? "text").toLowerCase()
      if (type === "submit" || type === "button" || type === "image") continue
      const value = decode(tag.match(/value="([^"]*)"/i)?.[1] ?? "")
      if (type === "hidden") {
        fields[name] = value
        continue
      }
      const auto = tag.match(/autocomplete="([^"]+)"/i)?.[1] ?? ""
      if (/one-time-code/i.test(auto) || /otp/i.test(name) || /^(code|mfacode|verificationcode)$/i.test(name)) {
        field = name
        fields[name] = ""
      }
    }
    if (!field) continue
    return { action, field, fields }
  }
  return undefined
}

export function readPlaceOrder(body: string): PlaceOrderForm | undefined {
  const forms = [...body.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)]
  for (const form of forms) {
    const attrs = form[1] ?? ""
    const inner = form[2] ?? ""
    const action = decode(attrs.match(/action="([^"]+)"/i)?.[1] ?? "")
    const blob = `${action}\n${inner}`
    if (!/place-order|static-submit|placeYourOrder|submitOrder/i.test(blob)) continue
    const fields: Record<string, string> = {}
    for (const input of inner.matchAll(/<input\b([^>]*)>/gi)) {
      const tag = input[1] ?? ""
      const name = tag.match(/name="([^"]+)"/i)?.[1]
      if (!name) continue
      fields[decode(name)] = decode(tag.match(/value="([^"]*)"/i)?.[1] ?? "")
    }
    if (!Object.keys(fields).length && !action) continue
    return { action, fields }
  }
  return undefined
}

export function cardField(fields: Record<string, string>): boolean {
  return Object.keys(fields).some((name) => /card.?number|creditcard|addcreditcard|cvv|cvc|securitycode/i.test(name))
}

export function readOrderId(body: string): string | undefined {
  return body.match(/\b\d{3}-\d{7}-\d{7}\b/)?.[0]
}

export function outOfStock(body: string): boolean {
  const lower = body.toLowerCase()
  return lower.includes("no longer available") || lower.includes("currently unavailable") || lower.includes("this item is not available")
}

function offerFrom(chunk: string): AmazonOffer | null {
  const soldRegion = chunk.match(/id="aod-offer-soldBy"[\s\S]{0,1500}/i)?.[0] ?? ""
  if (!soldRegion) return null
  const merchantId = soldRegion.match(/[?&]seller=([A-Z0-9]+)/i)?.[1]
  const fulfilledByAmazon = /isAmazonFulfilled=1/i.test(soldRegion)
  const seller = clean(soldRegion.match(/aria-label="([^"]+?)\.\s*Opens a new page"/i)?.[1] ?? soldRegion.match(/>([^<]{2,80})<\/a>/)?.[1] ?? "")
  const shipsFrom = clean(chunk.match(/Ships from<\/span>[\s\S]{0,500}?a-color-base">\s*([^<]+)/i)?.[1] ?? "")
  const priceText = chunk.match(/and price \$([0-9,]+\.\d{2})/i)?.[1] ?? chunk.match(/apex-pricetopay-accessibility-label">\s*\$([0-9,]+\.\d{2})/i)?.[1]
  const price = priceText ? money(priceText) : undefined
  const offerListingId = chunk.match(/name="items\[0\.base\]\[offerListingId\]" value="([^"]+)"/i)?.[1]
  const csrf = chunk.match(/name="anti-csrftoken-a2z" value="([^"]+)"/i)?.[1]
  const asin = chunk.match(/name="items\[0\.base\]\[asin\]" value="([^"]+)"/i)?.[1]
  if (!seller && !merchantId) return null
  const unavailable = /currently unavailable|temporarily out of stock|out of stock/i.test(chunk)
  return {
    seller,
    shipsFrom,
    merchantId,
    fulfilledByAmazon,
    price,
    offerListingId,
    csrf,
    asin,
    amazonRetail: isAmazonRetail(seller, shipsFrom, merchantId, fulfilledByAmazon),
    buyable: !unavailable && Boolean(offerListingId)
  }
}

function isAmazonRetail(seller: string, shipsFrom: string, merchantId: string | undefined, fulfilledByAmazon: boolean): boolean {
  const soldByAmazon = merchantId === AMAZON_RETAIL_ID || amazonName(seller)
  if (!soldByAmazon) return false
  if (fulfilledByAmazon && !amazonName(seller) && merchantId !== AMAZON_RETAIL_ID) return false
  if (!shipsFrom.trim()) return true
  return amazonName(shipsFrom)
}

function amazonName(value: string): boolean {
  const name = value.trim().toLowerCase().replace(/\s+/g, " ")
  return name === "amazon.com" || name === "amazon" || name === "amazon.com services llc"
}

function isNotFound(html: string): boolean {
  return /<title>[^<]*page not found/i.test(html) || /couldn't find that page/i.test(html)
}

function money(value: string): number {
  return Number(value.replace(/,/g, ""))
}

function clean(value: string): string {
  return decode(value).replace(/\s+/g, " ").trim()
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}
