import { cookieHeader, domainAllowed, earliestStoreExpiry, pairsFromHeader, siteOf, STORAGE_KEYS, STORE_ORIGINS } from "./policy.mjs"
import { openFrame, pairKey, seal, sessionKey } from "./wire.mjs"

const DEVICE_NAME = "Session Sync"
const FULL_MS = 15 * 60 * 1000

let socket = null
let generation = 0
let key = null
let mode = "pair"
let pcId = ""
let conn = ""
let relayId = ""
let usingRelay = false
let online = false
let writing = false
let writingTimer = null
let saved = null
let accounts = []
let links = []
let seen = new Set()
let lastError = ""
let lastFull = 0
const syncState = {}
const waiters = []
const rawWaiters = []

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create("tcgaio-keepalive", { periodInMinutes: 1 })
})

chrome.runtime.onStartup.addListener(() => {
  void boot()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tcgaio-keepalive") void keepalive()
})

chrome.cookies.onChanged.addListener((change) => {
  if (writing || change.removed) return
  const domain = change.cookie?.domain || ""
  for (const link of links) {
    if (domainAllowed(link.store, domain)) scheduleSync(link.accountId)
  }
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : "Session Sync failed." }))
  return true
})

void boot()

async function boot() {
  await chrome.alarms.create("tcgaio-keepalive", { periodInMinutes: 1 })
  const stored = await chrome.storage.local.get(["tcgaioLink", "tcgaioLinks"])
  saved = validLink(stored.tcgaioLink)
  links = normalizeLinks(stored.tcgaioLinks)
  if (!saved) return
  try {
    await connectSaved()
  } catch (err) {
    lastError = err instanceof Error ? err.message : "Could not reach the PC."
  }
}

async function keepalive() {
  if (!saved) {
    const stored = await chrome.storage.local.get("tcgaioLink")
    saved = validLink(stored.tcgaioLink)
  }
  if (!saved) return
  if (!online) {
    try {
      await connectSaved()
    } catch (err) {
      lastError = err instanceof Error ? err.message : "Could not reach the PC."
      return
    }
  }
  if (Date.now() - lastFull < FULL_MS) return
  lastFull = Date.now()
  for (const link of [...links]) {
    try {
      await syncAccount(link.accountId)
    } catch (err) {
      noteSync(link.accountId, err instanceof Error ? err.message : "Sync failed.")
    }
    if (!link.twoWay) continue
    try {
      await pullAccount(link.accountId)
    } catch (err) {
      noteSync(link.accountId, err instanceof Error ? err.message : "Pull failed.")
    }
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return status()
  if (message.op === "status") return status()
  if (message.op === "pair") {
    await pair(message.code)
    return status()
  }
  if (message.op === "refresh") {
    if (online) await request({ type: "sync" })
    else await connectSaved()
    return status()
  }
  if (message.op === "link") {
    await linkAccount(message.accountId, message.twoWay === true)
    return status()
  }
  if (message.op === "unlink") {
    await unlinkAccount(message.accountId)
    return status()
  }
  if (message.op === "sync") {
    await syncAccount(message.accountId)
    return status()
  }
  if (message.op === "pull") {
    await pullAccount(message.accountId)
    return status()
  }
  if (message.op === "disconnect") {
    await forget("Disconnected on this browser. Revoke Session Sync on the PC so the token stops working.")
    return status()
  }
  return status()
}

function status() {
  return {
    ok: true,
    paired: Boolean(saved),
    online,
    pcName: saved?.pcName || "",
    accounts,
    links,
    error: lastError,
    sync: syncState
  }
}

async function pair(code) {
  const payload = parseInvite(code)
  lastError = ""
  await openTransport(payload)
  mode = "pair"
  key = await pairKey(payload.secret)
  pcId = payload.pcId
  const paired = waitFor((item) => item.type === "paired" || item.type === "error")
  await send({ type: "pair", deviceName: DEVICE_NAME })
  const message = await paired
  if (message.type !== "paired") throw new Error(message.error || "Pairing did not finish.")
  saved = {
    token: message.token,
    deviceId: message.deviceId,
    pcId: payload.pcId,
    pcName: message.pcName,
    host: payload.host,
    port: payload.port,
    relay: payload.relay || ""
  }
  await chrome.storage.local.set({ tcgaioLink: saved })
  key = await sessionKey(saved.token)
  mode = "session"
  const snap = waitFor((item) => item.type === "snapshot" || item.type === "error")
  await send({ type: "hello" })
  const opened = await snap
  if (opened.type === "error") throw new Error(opened.error)
  online = true
  lastError = ""
}

async function connectSaved() {
  if (!saved) throw new Error("Pair Session Sync from the code on the PC.")
  const payload = {
    v: 1,
    pcId: saved.pcId,
    name: saved.pcName,
    host: saved.host,
    port: saved.port,
    secret: saved.token,
    relay: saved.relay || undefined
  }
  await openTransport(payload)
  mode = "session"
  key = await sessionKey(saved.token)
  pcId = saved.pcId
  const snap = waitFor((item) => item.type === "snapshot" || item.type === "error")
  await send({ type: "hello" })
  const opened = await snap
  if (opened.type === "error") throw new Error(opened.error)
  online = true
  lastError = ""
}

async function linkAccount(accountId, twoWay) {
  const account = accounts.find((item) => item.id === accountId)
  if (!account || !siteOf(account.store)) throw new Error("Choose an account from this PC.")
  await request({ type: "vault.link", accountId, twoWay })
  links = links.filter((item) => item.accountId !== accountId).concat([{ accountId, store: account.store, twoWay }])
  await chrome.storage.local.set({ tcgaioLinks: links })
}

async function unlinkAccount(accountId) {
  await request({ type: "vault.unlink", accountId })
  links = links.filter((item) => item.accountId !== accountId)
  await chrome.storage.local.set({ tcgaioLinks: links })
}

async function syncAccount(accountId) {
  const link = links.find((item) => item.accountId === accountId)
  if (!link) throw new Error("Link this account first.")
  const site = siteOf(link.store)
  if (!site) throw new Error("That store is not one of the seven Session Sync sites.")
  const all = await chrome.cookies.getAll({ domain: site })
  const storage = await readStorage(link.store)
  const header = cookieHeader(link.store, all, storage)
  if (!header) throw new Error("No store cookies yet. Sign in on this site, then sync.")
  const expiresAt = earliestStoreExpiry(link.store, all)
  await request({ type: "vault.push", accountId, cookie: header, expiresAt })
  noteSync(accountId, "")
}

async function pullAccount(accountId) {
  const link = links.find((item) => item.accountId === accountId)
  if (!link?.twoWay) throw new Error("Turn on two-way sync for this account first.")
  const result = await request({ type: "vault.pull", accountId })
  if (!result.cookie) throw new Error("This account has no saved session.")
  await applyHeader(link.store, result.cookie)
  noteSync(accountId, "")
}

async function readStorage(store) {
  const keys = STORAGE_KEYS[store] || []
  const site = siteOf(store)
  if (!keys.length || !site) return []
  const tabs = await chrome.tabs.query({ url: [`https://${site}/*`, `https://*.${site}/*`] })
  const tab = tabs.find((item) => typeof item.id === "number")
  if (!tab?.id) return []
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (allowed) => {
        const out = []
        for (const name of allowed) {
          const value = localStorage.getItem(name)
          if (value) out.push({ key: name, value })
        }
        return out
      },
      args: [keys]
    })
    return Array.isArray(result?.result) ? result.result : []
  } catch {
    return []
  }
}

async function applyHeader(store, header) {
  const url = STORE_ORIGINS[store]
  if (!url) return
  const pairs = pairsFromHeader(header)
  if (!pairs.length) return
  writing = true
  if (writingTimer) clearTimeout(writingTimer)
  try {
    for (const pair of pairs) {
      await chrome.cookies.set({ url, name: pair.name, value: pair.value, path: "/", secure: true })
    }
  } finally {
    writingTimer = setTimeout(() => {
      writing = false
    }, 1500)
  }
}

const pendingSync = new Map()

function scheduleSync(accountId) {
  const existing = pendingSync.get(accountId)
  if (existing) clearTimeout(existing)
  pendingSync.set(accountId, setTimeout(() => {
    pendingSync.delete(accountId)
    void syncAccount(accountId).catch((err) => noteSync(accountId, err instanceof Error ? err.message : "Sync failed."))
  }, 2000))
}

function noteSync(accountId, error) {
  syncState[accountId] = { at: Date.now(), error }
}

async function request(message) {
  if (!online || !conn) throw new Error("Session Sync is not connected to the PC.")
  const req = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const pending = waitFor((item) => item.type === "result" && item.req === req)
  await send({ ...message, req, conn })
  const result = await pending
  if (!result.ok) throw new Error(result.error || "The PC refused that request.")
  return result
}

async function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !key) throw new Error("Session Sync is not connected to the PC.")
  const frame = await seal(key, message, { mode, pcId, ...(relayId ? { rid: relayId } : {}) })
  if (usingRelay) socket.send(JSON.stringify({ op: "send", pc: pcId, body: frame }))
  else socket.send(frame)
}

async function openTransport(payload) {
  closeSocket()
  seen = new Set()
  conn = ""
  relayId = ""
  let directError = "Could not reach the PC."
  try {
    usingRelay = false
    await openSocket(`ws://${payload.host}:${payload.port}`)
    return
  } catch (err) {
    directError = err instanceof Error ? err.message : directError
  }
  if (!payload.relay) throw new Error(directError)
  usingRelay = true
  await openSocket(payload.relay)
  socket?.send(JSON.stringify({ op: "join", role: "phone", pc: payload.pcId }))
  const joined = JSON.parse(await waitRaw())
  if (joined.op !== "joined" || !joined.id) throw new Error("The relay did not accept this browser.")
  relayId = joined.id
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const current = generation
    const opened = new WebSocket(url)
    let settled = false
    const timer = setTimeout(() => {
      opened.close()
      finish(new Error("Timed out reaching the PC."))
    }, 4000)
    const finish = (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) reject(err)
      else resolve()
    }
    opened.addEventListener("open", () => {
      if (current !== generation) {
        opened.close()
        finish(new Error("The connection was replaced."))
        return
      }
      socket = opened
      finish()
    })
    opened.addEventListener("error", () => {
      if (!settled) finish(new Error("Could not open a connection to the PC."))
    })
    opened.addEventListener("message", (event) => {
      if (opened !== socket) return
      const text = typeof event.data === "string" ? event.data : ""
      if (!text) return
      if (usingRelay) {
        let outer
        try {
          outer = JSON.parse(text)
        } catch {
          return
        }
        if (outer.op === "joined") {
          deliverRaw(text)
          return
        }
        if (outer.op !== "deliver" || typeof outer.body !== "string") return
        void acceptFrame(outer.body)
        return
      }
      void acceptFrame(text)
    })
    opened.addEventListener("close", (event) => {
      if (socket !== opened) return
      socket = null
      online = false
      failWaiters(event.code === 4003 ? new Error("This browser was revoked on the PC. Pair it again.") : new Error("The PC connection closed."))
      if (event.code === 4003) void forget("This browser was revoked on the PC. Pair it again.")
    })
  })
}

async function acceptFrame(text) {
  if (!key) return
  let frame
  try {
    frame = JSON.parse(text)
  } catch {
    return
  }
  if (!frame || frame.pcId !== pcId || !frame.n || !frame.c) return
  try {
    const message = await openFrame(key, frame, Date.now(), seen)
    dispatch(message)
  } catch {
    // A frame for another device or a stale key does not change this browser.
  }
}

function dispatch(message) {
  if (!message || typeof message !== "object") return
  if (message.type === "snapshot") {
    if (typeof message.conn === "string" && message.conn) conn = message.conn
    accounts = Array.isArray(message.snapshot?.accounts) ? message.snapshot.accounts.map(publicAccount).filter((item) => item.id && siteOf(item.store)) : accounts
    online = true
  } else if (message.type === "presence") {
    online = true
  } else if (message.type === "vault.session") {
    const link = links.find((item) => item.accountId === message.accountId && item.twoWay)
    if (link && typeof message.cookie === "string") void applyHeader(link.store, message.cookie)
  } else if (message.type === "error") {
    lastError = String(message.error || "The PC closed this session.")
  }
  const index = waiters.findIndex((waiter) => waiter.match(message))
  if (index < 0) return
  const [waiter] = waiters.splice(index, 1)
  clearTimeout(waiter.timer)
  waiter.resolve(message)
}

function publicAccount(account) {
  return {
    id: String(account.id || ""),
    store: String(account.store || ""),
    label: String(account.label || "Account"),
    hasSession: account.hasSession === true
  }
}

function waitFor(match, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.findIndex((waiter) => waiter.timer === timer)
      if (index >= 0) waiters.splice(index, 1)
      reject(new Error("The PC did not answer."))
    }, timeoutMs)
    waiters.push({ match, resolve, reject, timer })
  })
}

function waitRaw(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The relay did not answer.")), timeoutMs)
    rawWaiters.push({
      resolve: (text) => {
        clearTimeout(timer)
        resolve(text)
      },
      reject,
      timer
    })
  })
}

function deliverRaw(text) {
  const waiter = rawWaiters.shift()
  if (!waiter) return
  clearTimeout(waiter.timer)
  waiter.resolve(text)
}

function failWaiters(err) {
  for (const waiter of waiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.reject(err)
  }
  for (const waiter of rawWaiters.splice(0)) {
    clearTimeout(waiter.timer)
    waiter.reject(err)
  }
}

function closeSocket() {
  generation += 1
  const current = socket
  socket = null
  online = false
  usingRelay = false
  relayId = ""
  failWaiters(new Error("The connection was replaced."))
  current?.close()
}

async function forget(reason) {
  closeSocket()
  saved = null
  links = []
  accounts = []
  conn = ""
  key = null
  lastError = reason
  await chrome.storage.local.remove(["tcgaioLink", "tcgaioLinks"])
}

function parseInvite(text) {
  let value
  try {
    value = JSON.parse(String(text || "").trim())
  } catch {
    throw new Error("That code is not a TCGAIO pairing code.")
  }
  if (!value || value.v !== 1) throw new Error("This pairing code is from a different TCGAIO version.")
  if (typeof value.pcId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.pcId)) throw new Error("Pairing code is missing the PC id.")
  if (typeof value.host !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.host)) throw new Error("Pairing code has an invalid address.")
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error("Pairing code has an invalid port.")
  if (typeof value.secret !== "string" || !value.secret) throw new Error("Pairing code is missing its one-time secret.")
  const payload = { v: 1, pcId: value.pcId, name: String(value.name || "TCGAIO"), host: value.host, port: value.port, secret: value.secret }
  if (typeof value.relay === "string" && value.relay.trim()) {
    if (!/^wss?:\/\/[^\s]+$/i.test(value.relay.trim())) throw new Error("Pairing code has an invalid relay.")
    payload.relay = value.relay.trim()
  }
  return payload
}

function validLink(value) {
  if (!value || typeof value !== "object") return null
  if (!value.token || !value.deviceId || !value.pcId || !value.host || !value.port) return null
  return value
}

function normalizeLinks(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => item && item.accountId && siteOf(item.store)).map((item) => ({
    accountId: String(item.accountId),
    store: String(item.store),
    twoWay: item.twoWay === true
  }))
}
