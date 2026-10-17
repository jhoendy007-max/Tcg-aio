const PAIR_INFO = new TextEncoder().encode("tcgaio-pair-v1")
const SESSION_INFO = new TextEncoder().encode("tcgaio-session-v1")

export function bytesToB64(bytes) {
  let bin = ""
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

export function b64ToBytes(value) {
  const pad = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4))
  const bin = atob(value.replace(/-/g, "+").replace(/_/g, "/") + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
  return out
}

async function derive(secret, info) {
  const base = await crypto.subtle.importKey("raw", b64ToBytes(secret), "HKDF", false, ["deriveBits"])
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info }, base, 256)
  return new Uint8Array(bits)
}

export function pairKey(secret) {
  return derive(secret, PAIR_INFO)
}

export function sessionKey(token) {
  return derive(token, SESSION_INFO)
}

export async function seal(key, message, header) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const plain = new TextEncoder().encode(JSON.stringify({ t: Date.now(), m: message }))
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"])
  const boxed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, plain))
  return JSON.stringify({
    v: 1,
    mode: header.mode,
    pcId: header.pcId,
    n: bytesToB64(nonce),
    c: bytesToB64(boxed),
    ...(header.rid ? { rid: header.rid } : {})
  })
}

export async function openFrame(key, frame, now, seen) {
  if (seen?.has(frame.n)) throw new Error("Rejected a replayed frame.")
  const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"])
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBytes(frame.n) }, cryptoKey, b64ToBytes(frame.c))
  const parsed = JSON.parse(new TextDecoder().decode(plain))
  if (typeof now === "number" && (typeof parsed.t !== "number" || Math.abs(now - parsed.t) > 120000)) {
    throw new Error("Frame is outside the time window.")
  }
  if (seen) seen.add(frame.n)
  return parsed.m
}
