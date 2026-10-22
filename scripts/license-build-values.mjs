import { createPublicKey } from "node:crypto"

export function normalizeLicenseUrl(raw) {
  const text = String(raw ?? "").trim().replace(/\/$/, "")
  if (!text) return ""
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    throw new Error("TCGAIO_LICENSE_URL is not a URL.")
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error("TCGAIO_LICENSE_URL must be an https URL.")
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("TCGAIO_LICENSE_URL must be the https origin only, with no token or path.")
  }
  return parsed.origin
}

function keyProblem(raw, detail) {
  const text = String(raw ?? "")
  const flags = [`input length ${text.length}`]
  if (/-----BEGIN PUBLIC KEY-----/i.test(text)) flags.push("pem")
  if (/PRIVATE/i.test(text)) flags.push("mentions private")
  if (/TCGAIO_LICENSE_PUBLIC_KEY\s*=/i.test(text)) flags.push("labeled public")
  if (/TCGAIO_LICENSE_PRIVATE_KEY\s*=/i.test(text)) flags.push("labeled private")
  if (/\s/.test(text)) flags.push("whitespace")
  if (/[^A-Za-z0-9+/=\s_\-"'\r\n]/.test(text)) flags.push("other characters")
  return new Error(`TCGAIO_LICENSE_PUBLIC_KEY is not the Ed25519 public key from keygen (${detail}; ${flags.join(", ")}).`)
}

export function normalizeLicenseKey(raw) {
  let text = String(raw ?? "").trim().replace(/^\uFEFF/, "")
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1).trim()
  const pem = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/i.exec(text)
  const labeled = /TCGAIO_LICENSE_PUBLIC_KEY\s*=\s*([A-Za-z0-9+/_=-]+)/i.exec(text)
  if (pem) text = pem[1]
  else if (labeled) text = labeled[1]
  else text = text.replace(/^TCGAIO_LICENSE_PUBLIC_KEY=/i, "")
  text = text.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/")
  if (text.length % 4 !== 0) text += "=".repeat(4 - (text.length % 4))
  const der = Buffer.from(text, "base64")
  if (der.length !== 44) throw keyProblem(raw, `decoded ${der.length} bytes, expected 44`)
  let parsed
  try {
    parsed = createPublicKey({ key: der, format: "der", type: "spki" })
  } catch {
    throw keyProblem(raw, "SPKI parse failed")
  }
  if (parsed.asymmetricKeyType !== "ed25519") throw keyProblem(raw, `type ${parsed.asymmetricKeyType ?? "unknown"}`)
  return der.toString("base64")
}
