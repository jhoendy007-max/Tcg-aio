import { constants, publicEncrypt } from "node:crypto"

/** Best Buy TAS encryption: RSA-OAEP with SHA-1 over the prefix `00960001` plus the PAN. CVV stays on the same www.bestbuy.com payment request. */
export function encryptBestBuyPan(pan: string, publicKey: string): string {
  const digits = pan.replace(/\D/g, "")
  const pem = publicKey.includes("BEGIN PUBLIC KEY")
    ? publicKey
    : `-----BEGIN PUBLIC KEY-----\n${publicKey.replace(/\s+/g, "")}\n-----END PUBLIC KEY-----`
  const encrypted = publicEncrypt(
    { key: pem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    Buffer.from(`00960001${digits}`)
  )
  return encrypted.toString("base64")
}
