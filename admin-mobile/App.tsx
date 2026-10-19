import { useEffect, useRef, useState } from "react"
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import Constants from "expo-constants"
import { StatusBar } from "expo-status-bar"
import * as FileSystem from "expo-file-system/legacy"
import * as IntentLauncher from "expo-intent-launcher"
import * as LocalAuthentication from "expo-local-authentication"
import * as Notifications from "expo-notifications"
import * as SecureStore from "expo-secure-store"

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
const versionCode = Number(Constants.expoConfig?.android?.versionCode ?? 0)
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

export default function App() {
  const [phase, setPhase] = useState<Phase>("boot")
  const [tab, setTab] = useState<DeskTab>("pending")
  const [base, setBase] = useState(bakedUrl)
  const [email, setEmail] = useState("jhoendy007@gmail.com")
  const [password, setPassword] = useState("")
  const [token, setToken] = useState("")
  const [note, setNote] = useState("")
  const [plan, setPlan] = useState("standard")
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
  const [updateHint, setUpdateHint] = useState("")
  const [updateCode, setUpdateCode] = useState(0)
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const seenPending = useRef<number | null>(null)
  const sessionGen = useRef(0)

  useEffect(() => { void restore() }, [])

  useEffect(() => {
    if (phase !== "desk" || !token) return
    const timer = setInterval(() => { void refresh(base, token, query, tab, false).catch(report) }, 15000)
    return () => clearInterval(timer)
  }, [phase, token, base, query, tab])

  async function restore() {
    try {
      const savedUrl = await SecureStore.getItemAsync("tcgaio-admin-url")
      const savedEmail = await SecureStore.getItemAsync("tcgaio-admin-email")
      const savedToken = await SecureStore.getItemAsync("tcgaio-admin-token")
      const savedExp = Number(await SecureStore.getItemAsync("tcgaio-admin-exp") ?? "0")
      const server = (savedUrl || bakedUrl).replace(/\/$/, "")
      setBase(server)
      if (savedEmail) setEmail(savedEmail)
      if (savedToken && savedExp > Date.now()) {
        setToken(savedToken)
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
  }

  async function endSession(message: string) {
    sessionGen.current += 1
    await clearStoredSession()
    setToken("")
    setPassword("")
    setCreatedKey("")
    setCreatedId("")
    setUpdateHint("")
    setUpdateCode(0)
    setPhase("login")
    setError(message)
  }

  function report(err: unknown) {
    if (err instanceof DeskAuthError) {
      void endSession(err.message || "Sign in to the admin desk again.")
      return
    }
    setError(err instanceof Error ? err.message : "Request failed.")
  }

  async function call(server: string, path: string, auth: string, method = "GET", body?: unknown, login = false): Promise<Record<string, unknown>> {
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
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: "Unlock TCGAIO Admin" })
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
      const payload = await call(server, "/v1/admin/login", "", "POST", { email: email.trim(), password }, true)
      const next = String(payload.token ?? "")
      const exp = Number(payload.expiresAt ?? 0)
      if (!next) throw new Error("The server did not return a sign-in token.")
      const savedEmail = email.trim()
      await SecureStore.setItemAsync("tcgaio-admin-url", server)
      await SecureStore.setItemAsync("tcgaio-admin-email", savedEmail)
      await SecureStore.setItemAsync("tcgaio-admin-token", next)
      await SecureStore.setItemAsync("tcgaio-admin-exp", String(exp))
      setBase(server)
      setEmail(savedEmail)
      setToken(next)
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
    await endSession("")
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

  async function checkUpdate() {
    setError("")
    try {
      const info = await call(base, "/v1/admin/app", token)
      const remote = Number(info.versionCode ?? 0)
      if (info.available === true && remote > versionCode) {
        setUpdateCode(remote)
        setUpdateHint(`Admin ${String(info.version)} is ready to install.`)
      } else {
        setUpdateCode(0)
        setUpdateHint(info.available === true ? "This admin app is current." : "No admin update is on the server yet.")
      }
    } catch (err) {
      report(err)
    }
  }

  async function installUpdate() {
    setBusy(true)
    setError("")
    try {
      const dest = `${FileSystem.cacheDirectory ?? ""}tcgaio-admin-update.apk`
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined)
      const result = await FileSystem.createDownloadResumable(`${base}/v1/admin/app/download`, dest, { headers: { authorization: `Bearer ${token}` } }).downloadAsync()
      if (!result?.uri) throw new Error("The update download did not finish.")
      const content = await FileSystem.getContentUriAsync(result.uri)
      await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
        data: content,
        flags: 1,
        type: "application/vnd.android.package-archive"
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not install the update."
      if (message.includes("401") || message.includes("Sign in to the admin desk again.")) report(new DeskAuthError("Sign in to the admin desk again."))
      else report(err)
    } finally {
      setBusy(false)
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
        refreshControl={phase === "desk" ? <RefreshControl refreshing={refreshing} onRefresh={() => void pull()} tintColor="#e0b15a" colors={["#e0b15a"]} progressBackgroundColor="#171b22" /> : undefined}
      >
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.mark}>TCGAIO</Text>
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
            <TextInput style={styles.input} secureTextEntry value={password} onChangeText={setPassword} />
            <Pressable style={styles.primary} disabled={busy} onPress={() => void signIn()}><Text style={styles.primaryText}>{busy ? "Signing in…" : "Sign in"}</Text></Pressable>
          </View>
        ) : null}
        {phase === "desk" ? (
          <View style={styles.desk}>
            <View style={styles.toolbar}>
              <Pressable style={styles.ghost} onPress={() => void checkUpdate()}><Text style={styles.ghostText}>Check for updates</Text></Pressable>
            </View>
            {updateHint ? <Text style={styles.hint}>{updateHint}</Text> : null}
            {updateCode > versionCode ? <Pressable style={styles.primary} disabled={busy} onPress={() => void installUpdate()}><Text style={styles.primaryText}>{busy ? "Installing…" : "Install update"}</Text></Pressable> : null}
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
                {row.role === "owner" ? <Text style={styles.hint}>This owner account stays active.</Text> : (
                  <View style={styles.cardBody}>
                    <Text style={styles.label}>Payment method</Text>
                    <TextInput style={styles.input} value={row.paymentMethod || "Not configured"} placeholder="Not configured" placeholderTextColor="#6d7585" onEndEditing={(event) => void userAct(row.id, "payment", { paymentMethod: event.nativeEvent.text })} />
                    <Pressable style={styles.check} onPress={() => void userAct(row.id, "paid", { paid: !row.paid })} accessibilityRole="checkbox" accessibilityState={{ checked: row.paid }}>
                      <View style={[styles.box, row.paid && styles.boxOn]}>{row.paid ? <Text style={styles.boxMark}>✓</Text> : null}</View>
                      <Text style={styles.checkLabel}>Paid</Text>
                    </Pressable>
                    {!row.licenseId ? <Pressable style={styles.primary} onPress={() => void userAct(row.id, "license")}><Text style={styles.primaryText}>Generate and link license</Text></Pressable> : <Text style={styles.hint}>{row.plan || "standard"} license linked</Text>}
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
                  <TextInput style={styles.input} value={plan} onChangeText={setPlan} />
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
                    <Text style={styles.hint}>{row.plan} · PC {row.fingerprint || "not bound"}</Text>
                    <View style={styles.rowActions}>
                      {row.status === "draft" || row.status === "suspended" ? <Pressable style={styles.ghost} onPress={() => void act(row.id, "access")}><Text style={styles.ghostText}>Give access</Text></Pressable> : null}
                      <Pressable style={styles.ghost} onPress={() => void act(row.id, "reset")}><Text style={styles.ghostText}>Reset PC</Text></Pressable>
                      <Pressable style={styles.ghost} onPress={() => void act(row.id, "suspend")}><Text style={styles.ghostText}>Suspend</Text></Pressable>
                      <Pressable style={styles.ghost} onPress={() => void act(row.id, "revoke")}><Text style={styles.ghostText}>Revoke</Text></Pressable>
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
  page: { flex: 1, backgroundColor: "#0e1116" },
  content: { padding: 16, paddingTop: 54, paddingBottom: 32, gap: 12 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  headerCopy: { flexDirection: "row", alignItems: "baseline", gap: 8, flexShrink: 1 },
  mark: { color: "#e0b15a", fontSize: 13, fontWeight: "800", letterSpacing: 1.2 },
  title: { color: "#f2f5f8", fontSize: 28, fontWeight: "700" },
  version: { color: "#6d7585", fontSize: 12 },
  signOut: { borderWidth: 1, borderColor: "#3c4658", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  signOutText: { color: "#f2f5f8", fontSize: 13, fontWeight: "700" },
  desk: { gap: 10 },
  toolbar: { flexDirection: "row", justifyContent: "flex-start" },
  pills: { gap: 8, paddingVertical: 2 },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#171b22", borderColor: "#2a3140", borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 8 },
  pillOn: { backgroundColor: "#e0b15a", borderColor: "#e0b15a" },
  pillText: { color: "#d5dbe3", fontSize: 13, fontWeight: "700" },
  pillTextOn: { color: "#1c1508" },
  count: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: "#2a3140", alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  countOn: { backgroundColor: "#1c1508" },
  countText: { color: "#e0b15a", fontSize: 11, fontWeight: "800" },
  countTextOn: { color: "#e0b15a" },
  card: { backgroundColor: "#171b22", borderRadius: 16, borderWidth: 1, borderColor: "#2a3140", padding: 14, gap: 8 },
  keyCard: { backgroundColor: "#221c12", borderRadius: 16, borderWidth: 1, borderColor: "#6d5424", padding: 14, gap: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardTitle: { color: "#f2f5f8", fontSize: 16, fontWeight: "700" },
  cardBody: { gap: 8 },
  email: { color: "#f2f5f8", fontSize: 16, fontWeight: "700", flex: 1 },
  label: { color: "#93a0b5", fontSize: 12, fontWeight: "600" },
  hint: { color: "#93a0b5", fontSize: 13, lineHeight: 18 },
  error: { color: "#ffd0d0", backgroundColor: "#3a1d1d", borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, overflow: "hidden" },
  input: { backgroundColor: "#10141b", color: "#f2f5f8", borderRadius: 12, borderWidth: 1, borderColor: "#2a3140", paddingHorizontal: 12, paddingVertical: 10 },
  primary: { backgroundColor: "#e0b15a", borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14, alignItems: "center" },
  primaryText: { color: "#1c1508", fontWeight: "800", fontSize: 15 },
  ghost: { borderWidth: 1, borderColor: "#3c4658", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  ghostText: { color: "#e0b15a", fontSize: 13, fontWeight: "700" },
  link: { color: "#e0b15a", fontWeight: "700", paddingVertical: 4 },
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
  boxOn: { backgroundColor: "#e0b15a", borderColor: "#e0b15a" },
  boxMark: { color: "#1c1508", fontSize: 14, fontWeight: "800" },
  checkLabel: { color: "#f2f5f8", fontSize: 14, fontWeight: "700" },
  empty: { borderWidth: 1, borderColor: "#2a3140", borderStyle: "dashed", borderRadius: 16, paddingVertical: 28, paddingHorizontal: 16, alignItems: "center" },
  emptyTitle: { color: "#93a0b5", fontSize: 15, fontWeight: "700" },
  alertRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#2a3140" },
  alertName: { color: "#f2f5f8", fontSize: 14 },
  switchPill: { borderRadius: 999, backgroundColor: "#10141b", paddingHorizontal: 10, paddingVertical: 4 },
  switchOn: { backgroundColor: "#e0b15a" },
  switchText: { color: "#93a0b5", fontSize: 12, fontWeight: "800" },
  switchTextOn: { color: "#1c1508" }
})
