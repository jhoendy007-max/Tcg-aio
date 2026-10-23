import { useEffect, useRef, useState } from "react"
import { Alert, AppState, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import Constants from "expo-constants"
import { StatusBar } from "expo-status-bar"
import * as LocalAuthentication from "expo-local-authentication"
import * as Notifications from "expo-notifications"
import * as SecureStore from "expo-secure-store"

import { AdminUpdatePrompt } from "./UpdatePrompt"

const ALERTS = ["signup", "claimed", "foreign_pc", "failed_logins", "expiring", "revoked", "suspended", "server_error", "checkout"] as const
const DEFAULT_SERVER = "https://license.jokerzzztcg.com"
const TABS = ["pending", "active", "suspended", "gifts", "alerts"] as const

type Phase = "boot" | "login" | "unlock" | "desk"
type DeskTab = (typeof TABS)[number]
type Counts = { pending: number; active: number; suspended: number; gifts: number }
type UserRow = {
  id: string
  email: string
  role: string
  status: string
  createdAt: number
  paymentMethod: string
  paid: boolean
  licenseId: string
  fingerprint: string
  lastSeen: number | null
  plan: string
}
type LicenseRow = {
  id: string
  note: string
  plan: string
  status: string
  email: string
  role: string
  fingerprint: string
  lastSeen: number | null
}

class DeskAuthError extends Error {}

const bakedUrl = (process.env.EXPO_PUBLIC_TCGAIO_LICENSE_URL ?? "").replace(/\/$/, "") || DEFAULT_SERVER
const appVersion = Constants.expoConfig?.version ?? ""
const emptyCounts: Counts = { pending: 0, active: 0, suspended: 0, gifts: 0 }

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true
  })
})

function titleCase(value: string): string {
  return value.split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ")
}

function when(value: number): string {
  return value ? new Date(value).toLocaleDateString() : "earlier"
}

function emptyCopy(tab: DeskTab, query: string): string {
  if (query.trim()) return "No accounts match that search."
  if (tab === "pending") return "No pending users"
  if (tab === "active") return "No active users"
  if (tab === "suspended") return "No suspended users"
  return "No gift keys"
}

const PLAN_CHOICES: Array<[string, string]> = [["standard", "Standard (no ACO)"], ["aco", "ACO"]]

function PlanPicker({ value, onChange }: { value: string; onChange: (plan: string) => void }) {
  return (
    <View style={styles.row}>
      {PLAN_CHOICES.map(([id, label]) => (
        <Pressable key={id} style={[styles.pill, value === id && styles.pillOn]} onPress={() => onChange(id)} accessibilityRole="radio" accessibilityState={{ selected: value === id }}>
          <Text style={[styles.pillText, value === id && styles.pillTextOn]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("boot")
  const [tab, setTab] = useState<DeskTab>("pending")
  const [base, setBase] = useState(bakedUrl)
  const [email, setEmail] = useState("jhoendy007@gmail.com")
  const [password, setPassword] = useState("")
  const [token, setToken] = useState("")
  const [note, setNote] = useState("")
  const [plan, setPlan] = useState("standard")
  const [linkPlan, setLinkPlan] = useState("aco")
  const [days, setDays] = useState("365")
  const [createdKey, setCreatedKey] = useState("")
  const [createdId, setCreatedId] = useState("")
  const [query, setQuery] = useState("")
  const [users, setUsers] = useState<UserRow[]>([])
  const [rows, setRows] = useState<LicenseRow[]>([])
  const [counts, setCounts] = useState<Counts>(emptyCounts)
  const [toggles, setToggles] = useState<Record<string, boolean>>({})
  const [error, setError] = useState("")
  const [pushHint, setPushHint] = useState("")
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [passwordOpen, setPasswordOpen] = useState(false)
  const [currentPassword, setCurrentPassword] = useState("")
  const [nextPassword, setNextPassword] = useState("")
  const seenPending = useRef<number | null>(null)
  const sessionGen = useRef(0)
  // 0.2.39: short access token + rotating refresh token kept in SecureStore (Android Keystore-encrypted).
  const tokenRef = useRef("")
  const expRef = useRef(0)
  const renewing = useRef<Promise<string | null> | null>(null)

  useEffect(() => { void restore() }, [])

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && tokenRef.current) void renewSoon(base).catch(() => undefined)
    })
    return () => sub.remove()
  }, [base])

  useEffect(() => {
    if (phase !== "desk" || !token) return
    const timer = setInterval(() => { void renewSoon(base).catch(() => undefined).then(() => refresh(base, token, query, tab, false)).catch(report) }, 15000)
    return () => clearInterval(timer)
  }, [phase, token, base, query, tab])

  async function restore() {
    try {
      const savedUrl = await SecureStore.getItemAsync("tcgaio-admin-url")
      const savedEmail = await SecureStore.getItemAsync("tcgaio-admin-email")
      const savedToken = await SecureStore.getItemAsync("tcgaio-admin-token")
      const savedExp = Number(await SecureStore.getItemAsync("tcgaio-admin-exp") ?? "0")
      const savedRefresh = await SecureStore.getItemAsync("tcgaio-admin-refresh")
      const server = (savedUrl || bakedUrl).replace(/\/$/, "")
      setBase(server)
      if (savedEmail) setEmail(savedEmail)
      if (savedToken && (savedExp > Date.now() || savedRefresh)) {
        setToken(savedToken)
        tokenRef.current = savedToken
        expRef.current = savedExp
        const hardware = await LocalAuthentication.hasHardwareAsync().catch(() => false)
        const enrolled = hardware ? await LocalAuthentication.isEnrolledAsync().catch(() => false) : false
        if (enrolled) {
          setPhase("unlock")
          return
        }
        try {
          await refresh(server, savedToken, "", "pending", true)
          setPhase("desk")
        } catch (err) {
          report(err)
          if (!(err instanceof DeskAuthError)) setPhase("desk")
        }
        return
      }
      if (savedToken) await clearStoredSession()
      setToken("")
      setPhase("login")
    } catch (err) {
      report(err)
    }
  }

  async function clearStoredSession() {
    await SecureStore.deleteItemAsync("tcgaio-admin-token").catch(() => undefined)
    await SecureStore.deleteItemAsync("tcgaio-admin-exp").catch(() => undefined)
    await SecureStore.deleteItemAsync("tcgaio-admin-refresh").catch(() => undefined)
    tokenRef.current = ""
    expRef.current = 0
  }

  async function deviceId(): Promise<string> {
    const saved = await SecureStore.getItemAsync("tcgaio-admin-device")
    if (saved && /^[A-Za-z0-9_-]{16,128}$/.test(saved)) return saved
    const bytes = Array.from({ length: 24 }, () => Math.floor(Math.random() * 256))
    const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
    const random = crypto?.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(24))) : bytes
    const id = random.map((b) => b.toString(16).padStart(2, "0")).join("")
    await SecureStore.setItemAsync("tcgaio-admin-device", id)
    return id
  }

  async function storeSession(payload: Record<string, unknown>): Promise<string> {
    const next = String(payload.token ?? "")
    const exp = Number(payload.expiresAt ?? 0)
    if (!next) throw new Error("The server did not return a sign-in token.")
    await SecureStore.setItemAsync("tcgaio-admin-token", next)
    await SecureStore.setItemAsync("tcgaio-admin-exp", String(exp))
    if (typeof payload.refreshToken === "string" && payload.refreshToken) await SecureStore.setItemAsync("tcgaio-admin-refresh", payload.refreshToken)
    tokenRef.current = next
    expRef.current = exp
    setToken(next)
    return next
  }

  /** Swaps the refresh token for a new pair. null = the server says sign in again; throws on network trouble. */
  function renewAccess(server: string): Promise<string | null> {
    if (renewing.current) return renewing.current
    const run = (async () => {
      const refreshToken = await SecureStore.getItemAsync("tcgaio-admin-refresh")
      if (!refreshToken) return null
      const response = await fetch(`${server}/v1/admin/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken, deviceId: await deviceId() })
      })
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>
      if (response.status === 401) return null
      if (!response.ok || payload.ok === false) throw new Error(typeof payload.error === "string" ? payload.error : "Could not refresh the admin sign-in.")
      return storeSession(payload)
    })()
    renewing.current = run
    void run.finally(() => { renewing.current = null }).catch(() => undefined)
    return run
  }

  async function renewSoon(server: string) {
    if (!tokenRef.current) return
    if (expRef.current - Date.now() > 5 * 60 * 1000) return
    const next = await renewAccess(server)
    if (next === null && expRef.current <= Date.now()) await endSession("Sign in to the admin desk again.")
  }

  async function handleAuthError(message: string) {
    try {
      if (await renewAccess(base)) return
    } catch {
      return
    }
    await endSession(message)
  }

  async function endSession(message: string) {
    sessionGen.current += 1
    await clearStoredSession()
    setToken("")
    setPassword("")
    setCreatedKey("")
    setCreatedId("")
    setPhase("login")
    setError(message)
  }

  function report(err: unknown) {
    if (err instanceof DeskAuthError) {
      void handleAuthError(err.message || "Sign in to the admin desk again.")
      return
    }
    setError(err instanceof Error ? err.message : "Request failed.")
  }

  async function call(server: string, path: string, auth: string, method = "GET", body?: unknown, login = false, retried = false): Promise<Record<string, unknown>> {
    if (auth && tokenRef.current) auth = tokenRef.current
    const response = await fetch(`${server}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    const message = typeof payload.error === "string" ? payload.error : "Request failed."
    if (response.status === 401 && !login && !retried && auth) {
      const renewed = await renewAccess(server).catch(() => null)
      if (renewed) return call(server, path, renewed, method, body, login, true)
    }
    if (response.status === 401 && !login) throw new DeskAuthError(message || "Sign in to the admin desk again.")
    if (!response.ok || payload.ok === false) throw new Error(message)
    return payload
  }

  async function refresh(server: string, auth: string, search: string, which: DeskTab, announce: boolean) {
    const generation = sessionGen.current
    const status = which === "gifts" || which === "alerts" ? "" : which
    const data = await call(server, `/v1/admin/users?status=${status}&q=${encodeURIComponent(search)}`, auth)
    if (generation !== sessionGen.current) return
    const nextUsers = Array.isArray(data.users) ? data.users as UserRow[] : []
    const nextCount = Number(data.pendingCount ?? 0)
    if (seenPending.current !== null && nextCount > seenPending.current) {
      await Notifications.scheduleNotificationAsync({
        content: { title: "New signup", body: nextCount === 1 ? "1 account is waiting for a license." : `${nextCount} accounts are waiting for a license.` },
        trigger: null
      }).catch(() => undefined)
    }
    seenPending.current = nextCount
    setCounts({
      pending: nextCount,
      active: Number(data.activeCount ?? 0),
      suspended: Number(data.suspendedCount ?? 0),
      gifts: Number(data.giftCount ?? 0)
    })
    if (which !== "gifts" && which !== "alerts") setUsers(nextUsers.filter((row) => row.status === which))
    if (which === "gifts" || which === "alerts") {
      const overview = await call(server, `/v1/admin/overview?q=${encodeURIComponent(search)}`, auth)
      if (generation !== sessionGen.current) return
      setRows(Array.isArray(overview.licenses) ? overview.licenses as LicenseRow[] : [])
      setCounts({
        pending: Number(overview.pendingCount ?? nextCount),
        active: Number(overview.activeCount ?? 0),
        suspended: Number(overview.suspendedCount ?? 0),
        gifts: Number(overview.giftCount ?? 0)
      })
    }
    if (which === "alerts") {
      const notes = await call(server, "/v1/admin/notifications", auth)
      if (generation !== sessionGen.current) return
      setToggles((notes.notifications as Record<string, boolean>) ?? {})
    }
    if (announce) void registerPush(server, auth)
  }

  async function openDesk(server: string, auth: string) {
    setError("")
    await refresh(server, auth, query, tab, true)
  }

  async function unlock() {
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock Zzz AIO Admin" })
    if (!result.success) {
      setError("Unlock was cancelled.")
      return
    }
    try {
      await openDesk(base, token)
      setPhase("desk")
    } catch (err) {
      report(err)
    }
  }

  async function signIn() {
    setBusy(true)
    setError("")
    try {
      const server = (base.trim() || DEFAULT_SERVER).replace(/\/$/, "")
      const payload = await call(server, "/v1/admin/login", "", "POST", { email: email.trim(), password, deviceId: await deviceId() }, true)
      const savedEmail = email.trim()
      await SecureStore.deleteItemAsync("tcgaio-admin-refresh").catch(() => undefined)
      const next = await storeSession(payload)
      await SecureStore.setItemAsync("tcgaio-admin-url", server)
      await SecureStore.setItemAsync("tcgaio-admin-email", savedEmail)
      setBase(server)
      setEmail(savedEmail)
      setPassword("")
      await openDesk(server, next)
      setPhase("desk")
    } catch (err) {
      report(err)
    } finally {
      setBusy(false)
    }
  }

  async function signOut() {
    // Revoke the refresh token on the server; sign out locally even if offline.
    const refreshToken = await SecureStore.getItemAsync("tcgaio-admin-refresh").catch(() => null)
    const access = tokenRef.current
    await fetch(`${base}/v1/admin/logout`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(access ? { authorization: `Bearer ${access}` } : {}) },
      body: JSON.stringify(refreshToken ? { refreshToken } : {})
    }).catch(() => undefined)
    await endSession("")
  }

  async function changePassword() {
    setBusy(true)
    setError("")
    try {
      await call(base, "/v1/admin/password", token, "POST", { currentPassword, password: nextPassword })
      setCurrentPassword("")
      setNextPassword("")
      setPasswordOpen(false)
      await endSession("Password changed. Sign in with the new password.")
    } catch (err) {
      report(err)
    } finally {
      setBusy(false)
    }
  }

  async function registerPush(server: string, auth: string) {
    const projectId = String(Constants.expoConfig?.extra?.eas?.projectId ?? "")
    if (!projectId || projectId.startsWith("REPLACE")) {
      setPushHint("Push is off until extra.eas.projectId is set. Pending accounts still show a badge here.")
      return
    }
    const permission = await Notifications.requestPermissionsAsync()
    if (permission.status !== "granted") {
      setPushHint("Notification permission was not granted. The pending badge still updates.")
      return
    }
    const issued = await Notifications.getExpoPushTokenAsync({ projectId })
    await call(server, "/v1/admin/push", auth, "POST", { token: issued.data })
    setPushHint("This phone will receive admin alerts.")
  }

  async function choose(next: DeskTab) {
    setTab(next)
    setError("")
    try { await refresh(base, token, query, next, false) } catch (err) { report(err) }
  }

  async function pull() {
    setRefreshing(true)
    try { await refresh(base, token, query, tab, false) } catch (err) { report(err) } finally { setRefreshing(false) }
  }

  async function userAct(id: string, action: string, body?: unknown) {
    setError("")
    try {
      const payload = await call(base, `/v1/admin/users/${id}/${action}`, token, "POST", body ?? {})
      if (action === "license" && payload.key) {
        setCreatedKey(String(payload.key))
        setCreatedId("")
      }
      await refresh(base, token, query, tab, false)
    } catch (err) {
      report(err)
    }
  }

  async function createLicense() {
    setBusy(true)
    setError("")
    try {
      const span = Number(days || "365") * 86400000
      const payload = await call(base, "/v1/admin/licenses", token, "POST", { note, plan, expiresAt: Date.now() + span })
      setCreatedKey(String(payload.key ?? ""))
      setCreatedId(String(payload.id ?? ""))
      setTab("gifts")
      await refresh(base, token, query, "gifts", false)
    } catch (err) {
      report(err)
    } finally {
      setBusy(false)
    }
  }

  async function setLicensePlan(id: string, next: string) {
    setError("")
    try {
      await call(base, `/v1/admin/licenses/${id}/plan`, token, "POST", { plan: next })
      await refresh(base, token, query, tab, false)
    } catch (err) {
      report(err)
    }
  }

  function deleteKey(id: string, label: string) {
    Alert.alert(
      "Delete this key?",
      `Delete the key for ${label}? They lose access right away. Their account stays, back in Pending. This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete key",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setError("")
              try {
                await call(base, `/v1/admin/licenses/${id}`, token, "DELETE")
                await refresh(base, token, query, tab, false)
              } catch (err) {
                report(err)
              }
            })()
          }
        }
      ]
    )
  }

  async function act(id: string, action: string) {
    setError("")
    try {
      await call(base, `/v1/admin/licenses/${id}/${action}`, token, "POST", {})
      if (id === createdId && action === "access") setCreatedKey("")
      await refresh(base, token, query, tab, false)
    } catch (err) {
      report(err)
    }
  }

  async function saveToggle(type: string, enabled: boolean) {
    const next = { ...toggles, [type]: enabled }
    setToggles(next)
    try {
      const payload = await call(base, "/v1/admin/notifications", token, "PUT", next)
      setToggles((payload.notifications as Record<string, boolean>) ?? next)
    } catch (err) {
      report(err)
    }
  }

  const gifts = rows.filter((row) => !row.email)
  const showUsers = tab === "pending" || tab === "active" || tab === "suspended"

  return (
    <View style={styles.page}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        refreshControl={phase === "desk" ? <RefreshControl refreshing={refreshing} onRefresh={() => void pull()} tintColor="#8b5cf6" colors={["#8b5cf6"]} progressBackgroundColor="rgba(255,255,255,0.06)" /> : undefined}
      >
        <View style={styles.header}>
          <Image source={require("./assets/icon.png")} style={{ width: 40, height: 40, borderRadius: 10, marginRight: 10 }} accessibilityLabel="Zzz logo" />
          <View style={styles.headerCopy}>
            <Text style={styles.mark}>Zzz AIO Admin</Text>
            <Text style={styles.title}>Admin</Text>
            {appVersion ? <Text style={styles.version}>v{appVersion}</Text> : null}
          </View>
          {phase === "desk" ? <Pressable style={styles.signOut} onPress={() => void signOut()}><Text style={styles.signOutText}>Sign out</Text></Pressable> : null}
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {phase === "boot" ? <Text style={styles.hint}>Loading the admin desk…</Text> : null}
        {phase === "unlock" ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Unlock this phone</Text>
            <Text style={styles.hint}>The owner session for {email} is saved on {base}.</Text>
            <Pressable style={styles.primary} onPress={() => void unlock()}><Text style={styles.primaryText}>Unlock</Text></Pressable>
            <Pressable onPress={() => { setError(""); setPhase("login") }}><Text style={styles.link}>Use password</Text></Pressable>
          </View>
        ) : null}
        {phase === "login" ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Sign in</Text>
            <Text style={styles.hint}>The license server and email stay on this phone.</Text>
            <Text style={styles.label}>License server</Text>
            <TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} value={base} onChangeText={setBase} placeholder={DEFAULT_SERVER} placeholderTextColor="#6d7585" />
            <Text style={styles.label}>Email</Text>
            <TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" value={email} onChangeText={setEmail} />
            <Text style={styles.label}>Password</Text>
            <TextInput style={styles.input} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="password" value={password} onChangeText={setPassword} />
            <Pressable style={styles.primary} disabled={busy} onPress={() => void signIn()}><Text style={styles.primaryText}>{busy ? "Signing in…" : "Sign in"}</Text></Pressable>
          </View>
        ) : null}
        {phase === "login" ? <AdminUpdatePrompt base={base} token="" onAuthError={() => setError("Sign in to download the update.")} /> : null}
        {phase === "desk" ? (
          <View style={styles.desk}>
            <View style={styles.toolbar}>
              <Pressable style={styles.ghost} onPress={() => { setPasswordOpen((open) => !open); setError("") }}><Text style={styles.ghostText}>Change password</Text></Pressable>
            </View>
            {passwordOpen ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Change password</Text>
                <Text style={styles.hint}>Enter the current password. Saving signs out this desk and the desktop app.</Text>
                <Text style={styles.label}>Current password</Text>
                <TextInput style={styles.input} secureTextEntry value={currentPassword} onChangeText={setCurrentPassword} autoCapitalize="none" />
                <Text style={styles.label}>New password</Text>
                <TextInput style={styles.input} secureTextEntry value={nextPassword} onChangeText={setNextPassword} autoCapitalize="none" />
                <Pressable style={styles.primary} disabled={busy} onPress={() => void changePassword()}><Text style={styles.primaryText}>{busy ? "Saving…" : "Save password"}</Text></Pressable>
              </View>
            ) : null}
            <AdminUpdatePrompt base={base} token={token} onAuthError={(message) => void handleAuthError(message)} />
            {createdKey ? (
              <View style={styles.keyCard}>
                <Text style={styles.label}>License key, copy it now</Text>
                <Text selectable style={styles.key}>{createdKey}</Text>
                {createdId ? <Pressable style={styles.primary} onPress={() => void act(createdId, "access")}><Text style={styles.primaryText}>Give access</Text></Pressable> : null}
              </View>
            ) : null}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pills}>
              {TABS.map((name) => {
                const count = name === "alerts" ? 0 : counts[name]
                const on = tab === name
                return (
                  <Pressable key={name} style={[styles.pill, on && styles.pillOn]} onPress={() => void choose(name)}>
                    <Text style={[styles.pillText, on && styles.pillTextOn]}>{titleCase(name)}</Text>
                    {count > 0 ? <View style={[styles.count, on && styles.countOn]}><Text style={[styles.countText, on && styles.countTextOn]}>{count}</Text></View> : null}
                  </Pressable>
                )
              })}
            </ScrollView>
            {tab !== "alerts" ? (
              <TextInput
                style={styles.input}
                value={query}
                onChangeText={setQuery}
                placeholder={tab === "gifts" ? "Search gift keys" : "Search email"}
                placeholderTextColor="#6d7585"
                autoCapitalize="none"
                autoCorrect={false}
                onSubmitEditing={() => void refresh(base, token, query, tab, false).catch(report)}
              />
            ) : null}
            {showUsers && users.length === 0 ? (
              <View style={styles.empty}><Text style={styles.emptyTitle}>{emptyCopy(tab, query)}</Text></View>
            ) : null}
            {showUsers ? users.map((row) => (
              <View key={row.id} style={styles.card}>
                <View style={styles.cardTop}>
                  <Text style={styles.email} numberOfLines={1}>{row.email}</Text>
                  <View style={[styles.status, row.role === "owner" ? styles.statusOwner : row.status === "active" ? styles.statusActive : row.status === "suspended" ? styles.statusSuspended : styles.statusPending]}>
                    <Text style={styles.statusText}>{row.role === "owner" ? "Owner" : titleCase(row.status)}</Text>
                  </View>
                </View>
                <Text style={styles.hint}>Signed up {when(row.createdAt)} · PC {row.fingerprint || "not bound"}</Text>
                {row.role === "owner" ? <Text style={styles.hint}>This owner account stays active on every PC.</Text> : (
                  <View style={styles.cardBody}>
                    <Text style={styles.label}>Payment method</Text>
                    <TextInput style={styles.input} value={row.paymentMethod || "Not configured"} placeholder="Not configured" placeholderTextColor="#6d7585" onEndEditing={(event) => void userAct(row.id, "payment", { paymentMethod: event.nativeEvent.text })} />
                    <Pressable style={styles.check} onPress={() => void userAct(row.id, "paid", { paid: !row.paid })} accessibilityRole="checkbox" accessibilityState={{ checked: row.paid }}>
                      <View style={[styles.box, row.paid && styles.boxOn]}>{row.paid ? <Text style={styles.boxMark}>✓</Text> : null}</View>
                      <Text style={styles.checkLabel}>Paid</Text>
                    </Pressable>
                    {!row.licenseId ? <PlanPicker value={linkPlan} onChange={setLinkPlan} /> : <PlanPicker value={row.plan || "standard"} onChange={(next) => void setLicensePlan(row.licenseId, next)} />}
                    {!row.licenseId ? <Pressable style={styles.primary} onPress={() => void userAct(row.id, "license", { plan: linkPlan })}><Text style={styles.primaryText}>Generate and link license</Text></Pressable> : <Pressable style={styles.danger} onPress={() => deleteKey(row.licenseId, row.email)}><Text style={styles.dangerText}>Delete key</Text></Pressable>}
                    <View style={styles.rowActions}>
                      {row.licenseId ? <Pressable style={styles.ghost} onPress={() => void userAct(row.id, "reset")}><Text style={styles.ghostText}>Reset PC</Text></Pressable> : null}
                      <Pressable style={styles.ghost} onPress={() => void userAct(row.id, row.status === "suspended" ? "unsuspend" : "suspend")}><Text style={styles.ghostText}>{row.status === "suspended" ? "Unsuspend" : "Suspend"}</Text></Pressable>
                    </View>
                  </View>
                )}
              </View>
            )) : null}
            {tab === "gifts" ? (
              <View style={styles.desk}>
                <View style={styles.card}>
                  <Text style={styles.cardTitle}>New gift key</Text>
                  <Text style={styles.label}>Note</Text>
                  <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="Gift" placeholderTextColor="#6d7585" />
                  <Text style={styles.label}>Plan</Text>
                  <PlanPicker value={plan} onChange={setPlan} />
                  <Text style={styles.label}>Expires in days</Text>
                  <TextInput style={styles.input} keyboardType="number-pad" value={days} onChangeText={setDays} />
                  <Pressable style={styles.primary} onPress={() => void createLicense()} disabled={busy}><Text style={styles.primaryText}>{busy ? "Creating…" : "Create gift key"}</Text></Pressable>
                </View>
                {gifts.length === 0 ? <View style={styles.empty}><Text style={styles.emptyTitle}>{emptyCopy("gifts", query)}</Text></View> : null}
                {gifts.map((row) => (
                  <View key={row.id} style={styles.card}>
                    <View style={styles.cardTop}>
                      <Text style={styles.email} numberOfLines={1}>{row.note || "Gift key"}</Text>
                      <View style={[styles.status, row.status === "active" ? styles.statusActive : row.status === "suspended" ? styles.statusSuspended : styles.statusPending]}>
                        <Text style={styles.statusText}>{titleCase(row.status)}</Text>
                      </View>
                    </View>
                    <Text style={styles.hint}>PC {row.fingerprint || "not bound"}</Text>
                    <PlanPicker value={row.plan || "standard"} onChange={(next) => void setLicensePlan(row.id, next)} />
                    <View style={styles.rowActions}>
                      {row.status === "draft" || row.status === "suspended" ? <Pressable style={styles.ghost} onPress={() => void act(row.id, "access")}><Text style={styles.ghostText}>Give access</Text></Pressable> : null}
                      <Pressable style={styles.ghost} onPress={() => void act(row.id, "reset")}><Text style={styles.ghostText}>Reset PC</Text></Pressable>
                      <Pressable style={styles.ghost} onPress={() => void act(row.id, "suspend")}><Text style={styles.ghostText}>Suspend</Text></Pressable>
                      <Pressable style={styles.ghost} onPress={() => void act(row.id, "revoke")}><Text style={styles.ghostText}>Revoke</Text></Pressable>
                      <Pressable style={styles.danger} onPress={() => deleteKey(row.id, row.note || "this gift key")}><Text style={styles.dangerText}>Delete key</Text></Pressable>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
            {tab === "alerts" ? (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Alerts</Text>
                {pushHint ? <Text style={styles.hint}>{pushHint}</Text> : null}
                {ALERTS.map((type) => (
                  <Pressable key={type} style={styles.alertRow} onPress={() => void saveToggle(type, !toggles[type])}>
                    <Text style={styles.alertName}>{titleCase(type)}</Text>
                    <View style={[styles.switchPill, toggles[type] && styles.switchOn]}><Text style={[styles.switchText, toggles[type] && styles.switchTextOn]}>{toggles[type] ? "On" : "Off"}</Text></View>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#070a1f" },
  content: { padding: 16, paddingTop: 54, paddingBottom: 32, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  headerCopy: { flexDirection: "row", alignItems: "baseline", gap: 8, flexShrink: 1 },
  mark: { color: "#8b5cf6", fontSize: 13, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: "#f2f5f8", fontSize: 28, fontWeight: "700" },
  version: { color: "#6d7585", fontSize: 12 },
  signOut: { borderWidth: 1, borderColor: "#3c4658", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  signOutText: { color: "#f2f5f8", fontSize: 13, fontWeight: "700" },
  desk: { gap: 10 },
  toolbar: { flexDirection: "row", justifyContent: "flex-start", gap: 8, flexWrap: "wrap" },
  pills: { gap: 8, paddingVertical: 2 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(167,139,250,0.22)", borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  pillOn: { backgroundColor: "#8b5cf6", borderColor: "#8b5cf6" },
  pillText: { color: "#d5dbe3", fontSize: 13, fontWeight: "700" },
  pillTextOn: { color: "#ffffff" },
  count: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: "rgba(167,139,250,0.22)", alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  countOn: { backgroundColor: "#ffffff" },
  countText: { color: "#8b5cf6", fontSize: 11, fontWeight: "800" },
  countTextOn: { color: "#8b5cf6" },
  card: { backgroundColor: "rgba(255,255,255,0.06)", borderRadius: 16, borderWidth: 1, borderColor: "rgba(167,139,250,0.22)", padding: 14, gap: 8 },
  keyCard: { backgroundColor: "#221c12", borderRadius: 16, borderWidth: 1, borderColor: "#6d5424", padding: 14, gap: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { color: "#f2f5f8", fontSize: 16, fontWeight: "700" },
  cardBody: { gap: 8 },
  email: { color: "#f2f5f8", fontSize: 16, fontWeight: "700", flex: 1 },
  label: { color: "#93a0b5", fontSize: 12, fontWeight: "600" },
  hint: { color: "#93a0b5", fontSize: 13, lineHeight: 18 },
  error: { color: "#ffd0d0", backgroundColor: "#3a1d1d", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, overflow: "hidden" },
  input: { backgroundColor: "#10141b", color: "#f2f5f8", borderRadius: 12, borderWidth: 1, borderColor: "rgba(167,139,250,0.22)", paddingHorizontal: 12, paddingVertical: 10 },
  primary: { backgroundColor: "#8b5cf6", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, alignItems: "center" },
  primaryText: { color: "#ffffff", fontWeight: "800", fontSize: 15 },
  ghost: { borderWidth: 1, borderColor: "#3c4658", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  ghostText: { color: "#8b5cf6", fontSize: 13, fontWeight: "700" },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 6 },
  danger: { backgroundColor: "#b4232c", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  dangerText: { color: "#ffffff", fontSize: 13, fontWeight: "700" },
  link: { color: "#8b5cf6", fontWeight: "700", paddingVertical: 4 },
  key: { color: "#f2f5f8", fontSize: 15 },
  rowActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  status: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  statusPending: { backgroundColor: "#3d3420" },
  statusActive: { backgroundColor: "#163528" },
  statusSuspended: { backgroundColor: "#3a1d1d" },
  statusOwner: { backgroundColor: "#1d2433" },
  statusText: { color: "#f2f5f8", fontSize: 11, fontWeight: "800" },
  check: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, borderColor: "#6d7585", alignItems: "center", justifyContent: "center" },
  boxOn: { backgroundColor: "#8b5cf6", borderColor: "#8b5cf6" },
  boxMark: { color: "#ffffff", fontSize: 14, fontWeight: "800" },
  checkLabel: { color: "#f2f5f8", fontSize: 14, fontWeight: "700" },
  empty: { borderWidth: 1, borderColor: "rgba(167,139,250,0.22)", borderStyle: "dashed", borderRadius: 16, paddingVertical: 28, paddingHorizontal: 16, alignItems: "center" },
  emptyTitle: { color: "#93a0b5", fontSize: 15, fontWeight: "700" },
  alertRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, borderTopWidth: 1, borderTopColor: "rgba(167,139,250,0.22)" },
  alertName: { color: "#f2f5f8", fontSize: 14 },
  switchPill: { borderRadius: 999, backgroundColor: "#10141b", paddingHorizontal: 10, paddingVertical: 4 },
  switchOn: { backgroundColor: "#8b5cf6" },
  switchText: { color: "#93a0b5", fontSize: 12, fontWeight: "800" },
  switchTextOn: { color: "#ffffff" }
})
