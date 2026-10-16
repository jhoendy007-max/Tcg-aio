import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto"

export interface FlexContext {
  tokenUrl: string
  jwk: { kid: string; n: string; e: string }
  rawJwt: string
}

export interface CardInput {
  number: string
  securityCode: string
  expirationMonth: string
  expirationYear: string
}

/** CyberSource Flex Microform: RSA-OAEP SHA-1 + A256GCM compact JWE. The plaintext is sent only to flex.cybersource.com. */
export function readFlexContext(captureJwt: string): FlexContext {
  const parts = captureJwt.split(".")
  if (parts.length < 2) throw new Error("Pokémon Center capture context is not a JWT.")
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"))
  } catch {
    throw new Error("Pokémon Center capture context could not be read.")
  }
  const record = asRecord(payload)
  const flx = asRecord(record?.flx)
  const jwk = asRecord(flx?.jwk)
  const kid = typeof jwk?.kid === "string" ? jwk.kid : ""
  const n = typeof jwk?.n === "string" ? jwk.n : ""
  const e = typeof jwk?.e === "string" ? jwk.e : ""
  const origin = typeof flx?.origin === "string" ? flx.origin.replace(/\/$/, "") : ""
  const path = typeof flx?.path === "string" ? (flx.path.startsWith("/") ? flx.path : `/${flx.path}`) : ""
  if (!kid || !n || !e || !origin || !path) throw new Error("Pokémon Center capture context is missing the Flex key.")
  let tokenUrl: URL
  try {
    tokenUrl = new URL(`${origin}${path}`)
  } catch {
    throw new Error("Pokémon Center capture context has an invalid token URL.")
  }
  if (tokenUrl.protocol !== "https:" || tokenUrl.hostname !== "flex.cybersource.com") {
    throw new Error("Refusing a payment token host that is not flex.cybersource.com.")
  }
  return { tokenUrl: tokenUrl.toString(), jwk: { kid, n, e }, rawJwt: captureJwt }
}

export function createCardJwe(captureJwt: string, card: CardInput): string {
  const flex = readFlexContext(captureJwt)
  const month = card.expirationMonth.replace(/\D/g, "").padStart(2, "0")
  const year = card.expirationYear.replace(/\D/g, "")
  const plaintext = JSON.stringify({
    data: {
      CARD: {
        number: card.number.replace(/\D/g, ""),
        securityCode: card.securityCode,
        type: cardType(card.number),
        expirationMonth: month,
        expirationYear: year
      }
    },
    context: captureJwt,
    index: 0
  })
  const header = Buffer.from(JSON.stringify({ kid: flex.jwk.kid, alg: "RSA-OAEP", enc: "A256GCM" })).toString("base64url")
  const cek = randomBytes(32)
  const iv = randomBytes(12)
  const encryptedKey = publicEncrypt(
    {
      key: createPublicKey({ key: { kty: "RSA", n: flex.jwk.n, e: flex.jwk.e }, format: "jwk" }),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha1"
    },
    cek
  )
  const cipher = createCipheriv("aes-256-gcm", cek, iv)
  cipher.setAAD(Buffer.from(header))
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [header, encryptedKey.toString("base64url"), iv.toString("base64url"), ciphertext.toString("base64url"), tag.toString("base64url")].join(".")
}

export function readPaymentToken(body: string): string | undefined {
  const trimmed = body.trim().replace(/^"|"$/g, "")
  const json = asRecord(safeJson(trimmed))
  if (json) {
    const direct = json.jti ?? json.paymentToken ?? json.token
    if (typeof direct === "string" && direct.includes(".")) return readPaymentToken(direct)
    if (typeof direct === "string" && direct.trim()) return direct.trim()
  }
  const parts = trimmed.split(".")
  if (parts.length < 2) return undefined
  try {
    const payload = asRecord(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")))
    return typeof payload?.jti === "string" && payload.jti.trim() ? payload.jti.trim() : undefined
  } catch {
    return undefined
  }
}

export function cardType(number: string): string {
  const digits = number.replace(/\D/g, "")
  if (digits.startsWith("34") || digits.startsWith("37")) return "003"
  if (digits.startsWith("4")) return "001"
  if (digits.startsWith("5")) return "002"
  if (digits.startsWith("6")) return "004"
  return "001"
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
