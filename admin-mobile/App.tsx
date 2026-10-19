import { useEffect, useRef, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import Constants from "expo-constants"
import * as FileSystem from "expo-file-system/legacy"
import * as IntentLauncher from "expo-intent-launcher"
import * as LocalAuthentication from "expo-local-authentication"
import * as Notifications from "expo-notifications"
import * as SecureStore from "expo-secure-store"

const ALERTS = ["signup", "claimed", "foreign_pc", "failed_logins", "expiring", "revoked", "suspended", "server_error", "checkout"] as const
const DEFAULT_SERVER = "https://license.jokerzzztcg.com"

type Phase = "boot" | "login" | "unlock" | "desk"
type DeskTab = "pending" | "active" | "suspended" | "gifts" | "alerts"
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

const bakedUrl = (process.env.EXPO_PUBLIC_TCGAIO_LICENSE_URL ?? "").replace(/\/$/, "") || DEFAULT_SERVER
const versionCode = Number(Constants.expoConfig?.android?.versionCode ?? 0)

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true
  })
})

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
  const [pendingCount, setPendingCount] = useState(0)
  const [toggles, setToggles] = useState<Record<string, boolean>>({})
  const [error, setError] = useState("")
  const [pushHint, setPushHint] = useState("")
  const [updateHint, setUpdateHint] = useState("")
  const [updateCode, setUpdateCode] = useState(0)
  const [busy, setBusy] = useState(false)
  const seenPending = useRef<number | null>(null)

  useEffect(() => { void restore() }, [])

  useEffect(() => {
    if (phase !== "desk" || !token) return
    const timer = setInterval(() => { void refresh(base, token, query, tab, false) }, 15000)
    return () => clearInterval(timer)
  }, [phase, token, base, query, tab])

  async function restore() {
    const savedUrl = await SecureStore.getItemAsync("tcgaio-admin-url")
    const savedToken = await SecureStore.getItemAsync("tcgaio-admin-token")
    const savedExp = Number(await SecureStore.getItemAsync("tcgaio-admin-exp") ?? "0")
    const server = savedUrl || bakedUrl
    setBase(server)
    if (savedToken && savedExp > Date.now()) {
      setToken(savedToken)
      const hardware = await LocalAuthentication.hasHardwareAsync().catch(() => false)
      const enrolled = hardware ? await LocalAuthentication.isEnrolledAsync().catch(() => false) : false
      setPhase(enrolled ? "unlock" : "desk")
      if (!enrolled) void refresh(server, savedToken, "", "pending", true)
      return
    }
    setPhase("login")
  }

  async function call(server: string, path: string, auth: string, method = "GET", body?: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${server}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${auth}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok || payload.ok === false) throw new Error(typeof payload.error === "string" ? payload.error : "Request failed")
    return payload
  }

  async function refresh(server: string, auth: string, search: string, which: DeskTab, announce: boolean) {
    const data = await call(server, `/v1/admin/users?status=${which === "gifts" || which === "alerts" ? "" : which}&q=${encodeURIComponent(search)}`, auth)
    const nextUsers = Array.isArray(data.users) ? data.users as UserRow[] : []
    const nextCount = Number(data.pendingCount ?? 0)
    if (seenPending.current !== null && nextCount > seenPending.current) {
      await Notifications.scheduleNotificationAsync({
        content: { title: "New signup", body: nextCount === 1 ? "1 account is waiting for a license." : `${nextCount} accounts are waiting for a license.` },
        trigger: null
      }).catch(() => undefined)
    }
    seenPending.current = nextCount
    setPendingCount(nextCount)
    if (which !== "gifts" && which !== "alerts") setUsers(nextUsers.filter((row) => !which || row.status === which))
    if (which === "gifts" || which === "alerts") {
      const overview = await call(server, `/v1/admin/overview?q=${encodeURIComponent(search)}`, auth)
      setRows(Array.isArray(overview.licenses) ? overview.licenses as LicenseRow[] : [])
    }
    if (which === "alerts") {
      const notes = await call(server, "/v1/admin/notifications", auth)
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
    setPhase("desk")
    try { await openDesk(base, token) } catch (err) { setError(err instanceof Error ? err.message : "Could not load the desk.") }
  }

  async function signIn() {
    setBusy(true)
    setError("")
    try {
      const server = (base.trim() || DEFAULT_SERVER).replace(/\/$/, "")
      const payload = await call(server, "/v1/admin/login", "", "POST", { email: email.trim(), password })
      const next = String(payload.token ?? "")
      const exp = Number(payload.expiresAt ?? 0)
      if (!next) throw new Error("The server did not return a sign-in token.")
      await SecureStore.setItemAsync("tcgaio-admin-url", server)
      await SecureStore.setItemAsync("tcgaio-admin-token", next)
      await SecureStore.setItemAsync("tcgaio-admin-exp", String(exp))
      setBase(server)
      setToken(next)
      setPassword("")
      setPhase("desk")
      await openDesk(server, next)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.")
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
    try { await refresh(base, token, query, next, false) } catch (err) { setError(err instanceof Error ? err.message : "Could not refresh.") }
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
      setError(err instanceof Error ? err.message : "That action failed.")
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
      await refresh(base, token, query, "gifts", false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the license.")
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
      setError(err instanceof Error ? err.message : "That action failed.")
    }
  }

  async function saveToggle(type: string, enabled: boolean) {
    const next = { ...toggles, [type]: enabled }
    setToggles(next)
    try {
      const payload = await call(base, "/v1/admin/notifications", token, "PUT", next)
      setToggles((payload.notifications as Record<string, boolean>) ?? next)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save notifications.")
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
      setError(err instanceof Error ? err.message : "Could not check for an update.")
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
      setError(err instanceof Error ? err.message : "Could not install the update.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.title}>TCGAIO Admin</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {phase === "boot" ? <Text style={styles.hint}>Loading…</Text> : null}
      {phase === "unlock" ? (
        <View style={styles.card}>
          <Text style={styles.hint}>Use biometrics to open the saved owner session.</Text>
          <Pressable style={styles.primary} onPress={() => void unlock()}><Text style={styles.primaryText}>Unlock</Text></Pressable>
          <Pressable onPress={() => setPhase("login")}><Text style={styles.link}>Use password</Text></Pressable>
        </View>
      ) : null}
      {phase === "login" ? (
        <View style={styles.card}>
          <Text style={styles.label}>License server</Text>
          <TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} value={base} onChangeText={setBase} placeholder={DEFAULT_SERVER} placeholderTextColor="#8b909a" />
          <Text style={styles.label}>Email</Text>
          <TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} value={email} onChangeText={setEmail} />
          <Text style={styles.label}>Password</Text>
          <TextInput style={styles.input} secureTextEntry value={password} onChangeText={setPassword} />
          <Pressable style={styles.primary} disabled={busy} onPress={() => void signIn()}><Text style={styles.primaryText}>Sign in</Text></Pressable>
        </View>
      ) : null}
      {phase === "desk" ? (
        <View>
          <View style={styles.actions}>
            <Pressable onPress={() => void checkUpdate()}><Text style={styles.link}>Check for updates</Text></Pressable>
            {pendingCount > 0 ? <Text style={styles.badge}>{pendingCount} pending</Text> : null}
          </View>
          {createdKey ? (
            <View style={styles.card}>
              <Text style={styles.hint}>License key (copy it now)</Text>
              <Text selectable style={styles.key}>{createdKey}</Text>
            </View>
          ) : null}
          {updateHint ? <Text style={styles.hint}>{updateHint}</Text> : null}
          {updateCode > versionCode ? <Pressable style={styles.primary} disabled={busy} onPress={() => void installUpdate()}><Text style={styles.primaryText}>Install update</Text></Pressable> : null}
          <View style={styles.actions}>
            {(["pending", "active", "suspended", "gifts", "alerts"] as DeskTab[]).map((name) => (
              <Pressable key={name} onPress={() => void choose(name)}><Text style={tab === name ? styles.tabOn : styles.link}>{name}{name === "pending" && pendingCount ? ` ${pendingCount}` : ""}</Text></Pressable>
            ))}
          </View>
          <TextInput style={styles.input} value={query} onChangeText={setQuery} placeholder="Search email" placeholderTextColor="#8b909a" onSubmitEditing={() => void refresh(base, token, query, tab, false).catch((err: unknown) => setError(err instanceof Error ? err.message : "Search failed."))} />
          {tab !== "gifts" && tab !== "alerts" ? users.map((row) => (
            <View key={row.id} style={styles.card}>
              <Text style={styles.rowTitle}>{row.email}</Text>
              <Text style={styles.hint}>{row.status} · signed up {row.createdAt ? new Date(row.createdAt).toLocaleDateString() : "earlier"} · PC {row.fingerprint || "not bound"}</Text>
              {row.role !== "owner" ? (
                <View>
                  <TextInput style={styles.input} value={row.paymentMethod || "Not configured"} placeholder="Not configured" placeholderTextColor="#8b909a" onEndEditing={(event) => void userAct(row.id, "payment", { paymentMethod: event.nativeEvent.text })} />
                  <Pressable onPress={() => void userAct(row.id, "paid", { paid: !row.paid })}><Text style={styles.link}>{row.paid ? "Paid" : "Mark paid"}</Text></Pressable>
                  {!row.licenseId ? <Pressable style={styles.primary} onPress={() => void userAct(row.id, "license")}><Text style={styles.primaryText}>Generate and link license</Text></Pressable> : null}
                  <View style={styles.actions}>
                    {row.licenseId ? <Pressable onPress={() => void userAct(row.id, "reset")}><Text style={styles.link}>Reset PC</Text></Pressable> : null}
                    <Pressable onPress={() => void userAct(row.id, row.status === "suspended" ? "unsuspend" : "suspend")}><Text style={styles.link}>{row.status === "suspended" ? "Unsuspend" : "Suspend"}</Text></Pressable>
                  </View>
                </View>
              ) : <Text style={styles.hint}>Owner</Text>}
            </View>
          )) : null}
          {tab === "gifts" ? (
            <View>
              <Pressable style={styles.primary} onPress={() => void createLicense()} disabled={busy}><Text style={styles.primaryText}>Create gift key</Text></Pressable>
              <View style={styles.card}>
                <Text style={styles.label}>Note</Text>
                <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="Gift" placeholderTextColor="#8b909a" />
                <Text style={styles.label}>Plan</Text>
                <TextInput style={styles.input} value={plan} onChangeText={setPlan} />
                <Text style={styles.label}>Expires in days</Text>
                <TextInput style={styles.input} keyboardType="number-pad" value={days} onChangeText={setDays} />
              </View>
              {createdKey ? (
                <View style={styles.card}>
                  <Text style={styles.hint}>Gift key (copy it now)</Text>
                  <Text selectable style={styles.key}>{createdKey}</Text>
                  {createdId ? <Pressable style={styles.primary} onPress={() => void act(createdId, "access")}><Text style={styles.primaryText}>Give access</Text></Pressable> : null}
                </View>
              ) : null}
              {rows.filter((row) => !row.email).map((row) => (
                <View key={row.id} style={styles.card}>
                  <Text style={styles.rowTitle}>{(row.note || "Gift key")} · {row.status}</Text>
                  <Text style={styles.hint}>{row.plan} · PC {row.fingerprint || "not bound"}</Text>
                  <View style={styles.actions}>
                    {row.status === "draft" || row.status === "suspended" ? <Pressable onPress={() => void act(row.id, "access")}><Text style={styles.link}>Give access</Text></Pressable> : null}
                    <Pressable onPress={() => void act(row.id, "reset")}><Text style={styles.link}>Reset binding</Text></Pressable>
                    <Pressable onPress={() => void act(row.id, "suspend")}><Text style={styles.link}>Suspend</Text></Pressable>
                    <Pressable onPress={() => void act(row.id, "revoke")}><Text style={styles.link}>Revoke</Text></Pressable>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
          {tab === "alerts" ? (
            <View>
              {pushHint ? <Text style={styles.hint}>{pushHint}</Text> : null}
              {ALERTS.map((type) => (
                <Pressable key={type} style={styles.toggle} onPress={() => void saveToggle(type, !toggles[type])}>
                  <Text style={styles.hint}>{type}</Text>
                  <Text style={styles.link}>{toggles[type] ? "On" : "Off"}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#14161b" },
  content: { padding: 20, paddingTop: 48, gap: 12 },
  title: { color: "#f4f1ea", fontSize: 28, fontWeight: "700" },
  card: { backgroundColor: "#1d2026", borderRadius: 12, padding: 14, gap: 8, marginTop: 12 },
  label: { color: "#c8cdd4", fontSize: 13 },
  hint: { color: "#9aa1ab", fontSize: 14 },
  error: { color: "#ffb4b4", marginBottom: 8 },
  input: { backgroundColor: "#101216", color: "#f4f1ea", borderRadius: 8, padding: 12, marginTop: 8 },
  primary: { backgroundColor: "#e0b15a", borderRadius: 10, padding: 14, marginTop: 12, alignItems: "center" },
  primaryText: { color: "#1a1408", fontWeight: "700", fontSize: 16 },
  link: { color: "#e0b15a", paddingVertical: 6 },
  tabOn: { color: "#f4f1ea", fontWeight: "700", paddingVertical: 6 },
  key: { color: "#f4f1ea", fontSize: 16 },
  rowTitle: { color: "#f4f1ea", fontSize: 16, fontWeight: "600" },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 12, alignItems: "center" },
  toggle: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 },
  badge: { color: "#1a1408", backgroundColor: "#e0b15a", borderRadius: 999, overflow: "hidden", paddingHorizontal: 8, paddingVertical: 2, fontWeight: "700" }
})
