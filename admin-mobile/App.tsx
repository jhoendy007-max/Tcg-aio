import { useEffect, useState } from "react"
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native"
import Constants from "expo-constants"
import * as LocalAuthentication from "expo-local-authentication"
import * as Notifications from "expo-notifications"
import * as SecureStore from "expo-secure-store"

const ALERTS = ["claimed", "foreign_pc", "failed_logins", "expiring", "revoked", "suspended", "server_error", "checkout"] as const

type Phase = "boot" | "login" | "unlock" | "desk"
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

const bakedUrl = (process.env.EXPO_PUBLIC_TCGAIO_LICENSE_URL ?? "").replace(/\/$/, "")

export default function App() {
  const [phase, setPhase] = useState<Phase>("boot")
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
  const [rows, setRows] = useState<LicenseRow[]>([])
  const [toggles, setToggles] = useState<Record<string, boolean>>({})
  const [error, setError] = useState("")
  const [pushHint, setPushHint] = useState("")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void restore()
  }, [])

  async function restore() {
    const savedUrl = await SecureStore.getItemAsync("tcgaio-admin-url")
    const savedToken = await SecureStore.getItemAsync("tcgaio-admin-token")
    const savedExp = Number(await SecureStore.getItemAsync("tcgaio-admin-exp") ?? "0")
    if (savedUrl) setBase(savedUrl)
    if (savedToken && savedExp > Date.now()) {
      setToken(savedToken)
      const hardware = await LocalAuthentication.hasHardwareAsync().catch(() => false)
      const enrolled = hardware ? await LocalAuthentication.isEnrolledAsync().catch(() => false) : false
      setPhase(enrolled ? "unlock" : "desk")
      if (!enrolled) void openDesk(savedUrl || bakedUrl, savedToken)
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

  async function openDesk(server: string, auth: string) {
    setError("")
    const data = await call(server, `/v1/admin/overview?q=${encodeURIComponent(query)}`, auth)
    setRows(Array.isArray(data.licenses) ? data.licenses as LicenseRow[] : [])
    const notes = await call(server, "/v1/admin/notifications", auth)
    setToggles((notes.notifications as Record<string, boolean>) ?? {})
    void registerPush(server, auth)
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
      const server = base.trim().replace(/\/$/, "")
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
      setPushHint("Push is off until extra.eas.projectId is set and the app is rebuilt.")
      return
    }
    const permission = await Notifications.requestPermissionsAsync()
    if (permission.status !== "granted") {
      setPushHint("Notification permission was not granted.")
      return
    }
    const issued = await Notifications.getExpoPushTokenAsync({ projectId })
    await call(server, "/v1/admin/push", auth, "POST", { token: issued.data })
    setPushHint("This phone will receive admin alerts.")
  }

  async function createLicense() {
    setBusy(true)
    setError("")
    try {
      const span = Number(days || "365") * 86400000
      const payload = await call(base, "/v1/admin/licenses", token, "POST", { note, plan, expiresAt: Date.now() + span })
      setCreatedKey(String(payload.key ?? ""))
      setCreatedId(String(payload.id ?? ""))
      await openDesk(base, token)
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
      await openDesk(base, token)
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
          <TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} value={base} onChangeText={setBase} placeholder="https://license.example.com" placeholderTextColor="#8b909a" />
          <Text style={styles.label}>Email</Text>
          <TextInput style={styles.input} autoCapitalize="none" autoCorrect={false} value={email} onChangeText={setEmail} />
          <Text style={styles.label}>Password</Text>
          <TextInput style={styles.input} secureTextEntry value={password} onChangeText={setPassword} />
          <Pressable style={styles.primary} disabled={busy} onPress={() => void signIn()}><Text style={styles.primaryText}>Sign in</Text></Pressable>
        </View>
      ) : null}
      {phase === "desk" ? (
        <View>
          <Pressable style={styles.primary} onPress={() => void createLicense()} disabled={busy}><Text style={styles.primaryText}>Create license</Text></Pressable>
          <View style={styles.card}>
            <Text style={styles.label}>Note</Text>
            <TextInput style={styles.input} value={note} onChangeText={setNote} placeholder="Customer name" placeholderTextColor="#8b909a" />
            <Text style={styles.label}>Plan</Text>
            <TextInput style={styles.input} value={plan} onChangeText={setPlan} />
            <Text style={styles.label}>Expires in days</Text>
            <TextInput style={styles.input} keyboardType="number-pad" value={days} onChangeText={setDays} />
          </View>
          {createdKey ? (
            <View style={styles.card}>
              <Text style={styles.hint}>License key (copy it now)</Text>
              <Text selectable style={styles.key}>{createdKey}</Text>
              <Pressable style={styles.primary} onPress={() => void act(createdId, "access")}><Text style={styles.primaryText}>Give access</Text></Pressable>
            </View>
          ) : null}
          <TextInput style={styles.input} value={query} onChangeText={setQuery} placeholder="Search" placeholderTextColor="#8b909a" onSubmitEditing={() => void openDesk(base, token).catch((err: unknown) => setError(err instanceof Error ? err.message : "Search failed."))} />
          {rows.map((row) => (
            <View key={row.id} style={styles.card}>
              <Text style={styles.rowTitle}>{(row.note || "License")} · {row.status}{row.email ? ` · ${row.email}` : ""}</Text>
              <Text style={styles.hint}>{row.plan} · PC {row.fingerprint || "not bound"} · last seen {row.lastSeen ? new Date(row.lastSeen).toLocaleString() : "never"}</Text>
              <View style={styles.actions}>
                {row.status === "draft" || row.status === "suspended" ? <Pressable onPress={() => void act(row.id, "access")}><Text style={styles.link}>Give access</Text></Pressable> : null}
                <Pressable onPress={() => void act(row.id, "reset")}><Text style={styles.link}>Reset binding</Text></Pressable>
                {row.role !== "owner" ? <Pressable onPress={() => void act(row.id, "suspend")}><Text style={styles.link}>Suspend</Text></Pressable> : null}
                {row.role !== "owner" ? <Pressable onPress={() => void act(row.id, "revoke")}><Text style={styles.link}>Revoke</Text></Pressable> : null}
              </View>
            </View>
          ))}
          <Text style={styles.rowTitle}>Notifications</Text>
          {pushHint ? <Text style={styles.hint}>{pushHint}</Text> : null}
          {ALERTS.map((type) => (
            <Pressable key={type} style={styles.toggle} onPress={() => void saveToggle(type, !toggles[type])}>
              <Text style={styles.hint}>{type}</Text>
              <Text style={styles.link}>{toggles[type] ? "On" : "Off"}</Text>
            </Pressable>
          ))}
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
  key: { color: "#f4f1ea", fontSize: 16 },
  rowTitle: { color: "#f4f1ea", fontSize: 16, fontWeight: "600", marginTop: 8 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  toggle: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 8 }
})
