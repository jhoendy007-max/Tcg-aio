import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"

/** Fixed salt so the same PC always hashes the same way. Raw hardware ids are never sent. */
export const FINGERPRINT_SALT = "tcgaio-machine-v1"
export const GRANT_GRACE_MS = 72 * 60 * 60 * 1000
export const HEARTBEAT_MS = 4 * 60 * 60 * 1000
export const TRANSFER_MS = 30 * 24 * 60 * 60 * 1000
export const OWNER_DEVICE_LIMIT = 8
export const USER_DEVICE_LIMIT = 1

const FORBIDDEN = ["cardnumber", "card", "cvv", "password", "cookie", "cookies", "session", "pan", "proxy", "accesstoken"]

export { FEATURES, PLANS, PLAN_IDS, isPlanId, featuresForPlan, type FeatureId } from "./plans"

export interface AccessGrant {
  v: 1
  ok: true
  email: string
  role: "owner" | "user"
  licenseId: string
  holder: string
  plan: string
  /** Signed feature list. Only these features unlock on the PC. The owner always gets every feature. */
  features?: string[]
  expiresAt: number | null
  fingerprint: string
  serverTime: number
  graceMs: number
}

export function fingerprintHash(parts: string[], salt = FINGERPRINT_SALT): string {
  const normal = parts.map((part) => part.trim().toLowerCase()).filter(Boolean).sort()
  if (!salt.trim() || normal.length === 0) throw new Error("A machine fingerprint needs stable hardware ids.")
  return createHash("sha256").update(`${salt}\n${normal.join("\n")}`).digest("hex")
}

export function createLicenseIdentity(): { publicKey: string; privateKey: string } {
  const pair = generateKeyPairSync("ed25519")
  return {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")
  }
}

export function signEnvelope(privateKey: string, grant: AccessGrant): string {
  const body = Buffer.from(JSON.stringify(grant)).toString("base64url")
  const signature = sign(null, Buffer.from(body), createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" }))
  return `${body}.${signature.toString("base64url")}`
}

export function readGrant(envelope: string, publicKey: string): AccessGrant | null {
  const key = publicKey.trim()
  const parts = envelope.trim().split(".")
  if (!key || parts.length !== 2 || !parts[0] || !parts[1]) return null
  let ok = false
  try {
    ok = verify(
      null,
      Buffer.from(parts[0]),
      createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }),
      Buffer.from(parts[1], "base64url")
    )
  } catch {
    ok = false
  }
  if (!ok) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  if (hasForbidden(parsed)) return null
  const grant = parsed as Partial<AccessGrant>
  if (grant.v !== 1 || grant.ok !== true) return null
  if (grant.role !== "owner" && grant.role !== "user") return null
  if (typeof grant.email !== "string" || typeof grant.licenseId !== "string" || typeof grant.holder !== "string") return null
  if (typeof grant.plan !== "string" || typeof grant.fingerprint !== "string") return null
  if (!/^[0-9a-f]{64}$/.test(grant.fingerprint)) return null
  const expiresAt = grant.expiresAt === null ? null : Number(grant.expiresAt)
  const serverTime = Number(grant.serverTime)
  const graceMs = Number(grant.graceMs)
  if ((expiresAt !== null && !Number.isFinite(expiresAt)) || !Number.isFinite(serverTime) || !Number.isFinite(graceMs) || graceMs < 0 || graceMs > GRANT_GRACE_MS) return null
  return {
    v: 1,
    ok: true,
    email: grant.email.slice(0, 120),
    role: grant.role,
    licenseId: grant.licenseId,
    holder: grant.holder.slice(0, 80),
    plan: grant.plan.slice(0, 40),
    ...(Array.isArray(grant.features) ? { features: grant.features.filter((item): item is string => typeof item === "string").slice(0, 32) } : {}),
    expiresAt,
    fingerprint: grant.fingerprint,
    serverTime,
    graceMs
  }
}

/** A grant is usable only when the signature, this PC, and the grace window all match. Role comes from the signature. */
export function accessAllowed(grant: AccessGrant, liveFingerprint: string, now = Date.now()): boolean {
  if (!/^[0-9a-f]{64}$/.test(liveFingerprint) || grant.fingerprint !== liveFingerprint) return false
  if (grant.expiresAt !== null && grant.expiresAt <= now) return false
  if (now > grant.serverTime + grant.graceMs) return false
  return true
}

export function hasForbidden(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN.includes(key.toLowerCase())) return true
    if (hasForbidden(child)) return true
  }
  return false
}
