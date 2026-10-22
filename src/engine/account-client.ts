import type { Database } from "./database"
import { AppError } from "../shared/errors"
import { licensePublicKey, licenseServerUrl } from "../shared/license-config"
import { readGrant } from "../shared/license-proof"
import type { AccountView } from "../shared/types"

export async function syncAccount(db: Database, fingerprint: string, path: string, body: Record<string, unknown>): Promise<AccountView> {
  const base = licenseServerUrl(db.getSettings().licenseServerUrl)
  if (!base) throw new AppError("This build is not connected to a license server yet.")
  let response: Response
  try {
    response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, fingerprint })
    })
  } catch {
    db.refreshAccess(fingerprint)
    throw new AppError("The license server could not be reached.")
  }
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || parsed.ok !== true) {
    const message = typeof parsed.error === "string" ? parsed.error : "Sign-in did not succeed."
    if (response.status === 401 || response.status === 403) db.clearAccountSession()
    else db.refreshAccess(fingerprint)
    throw new AppError(message)
  }
  const token = typeof parsed.token === "string" ? parsed.token : ""
  if (parsed.pending === true) {
    if (!token) throw new AppError("The license server did not start a session.")
    return db.savePendingSession({ token, email: typeof parsed.email === "string" ? parsed.email : "", fingerprint })
  }
  const envelope = typeof parsed.envelope === "string" ? parsed.envelope : ""
  if (!token || !readGrant(envelope, licensePublicKey())) throw new AppError("The license server response could not be verified.")
  const view = db.saveAccountSession({ token, envelope, fingerprint })
  if (path === "/v1/account/login" || path === "/v1/account/claim" || path === "/v1/account/redeem") await confirmDevice(db, base, token)
  return view
}

async function confirmDevice(db: Database, base: string, token: string): Promise<void> {
  let response: Response
  try {
    response = await fetch(`${base}/v1/session/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token })
    })
  } catch {
    return
  }
  if (response.status === 404) return
  if (response.ok) return
  db.clearAccountSession()
  const parsed = await response.json().catch(() => ({})) as Record<string, unknown>
  const message = typeof parsed.error === "string" ? parsed.error : "This PC could not be confirmed."
  throw new AppError(message)
}

export async function heartbeatAccount(db: Database, fingerprint: string): Promise<AccountView> {
  const token = db.sessionToken()
  if (!token) {
    db.refreshAccess(fingerprint)
    return db.accountView()
  }
  try {
    return await syncAccount(db, fingerprint, "/v1/session/heartbeat", { token })
  } catch (err) {
    db.refreshAccess(fingerprint)
    if (!db.accountView().pending && !db.licenseAllows()) db.clearAccountSession()
    throw err
  }
}

export async function reportCheckout(db: Database, fingerprint: string, store: string, sku: string): Promise<void> {
  const token = db.sessionToken()
  const base = licenseServerUrl(db.getSettings().licenseServerUrl)
  if (!token || !base || !store || !sku) return
  try {
    await fetch(`${base}/v1/session/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, fingerprint, store, sku })
    })
  } catch {
    // A missed checkout notice does not stop the desktop app.
  }
}
