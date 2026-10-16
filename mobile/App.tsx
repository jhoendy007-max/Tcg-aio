import { StatusBar } from "expo-status-bar"
import { useEffect, useRef, useState } from "react"
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import { PhoneRevoked, PhoneSession, payloadFromScan, type SavedPhoneLink } from "../src/phone/client"
import type { PhoneChallenge, PhoneSnapshot, PhoneTask, PhoneTaskDraft } from "../src/phone/protocol"
import { ChallengeCard } from "./src/ChallengeCard"
import type { KeywordWatchInput, RestockRuleInput } from "../src/shared/types"
import { ensureNotificationPermission, notify } from "./src/notify"
import { clearLink, loadLink, saveLink } from "./src/storage"
import type { StoreHealth } from "../src/shared/types"
import { colors, isActive, STATUS_LABEL } from "./src/theme"

type Screen = "boot" | "pair" | "dash" | "edit" | "alerts"

const emptyDraft = (snap: PhoneSnapshot | null): PhoneTaskDraft => ({
  store: snap?.stores[0]?.id ?? "target",
  sku: "",
  quantity: 1,
  profileId: snap?.profiles[0]?.id ?? "",
  accountId: "",
  proxyGroupId: null,
  confirmPurchase: false,
  testMode: false
})

export default function App() {
  const session = useRef<PhoneSession | null>(null)
  const [screen, setScreen] = useState<Screen>("boot")
  const [online, setOnline] = useState(false)
  const [pcName, setPcName] = useState("TCGAIO")
  const [snap, setSnap] = useState<PhoneSnapshot | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<PhoneTaskDraft | null>(null)
  const [error, setError] = useState("")
  const [health, setHealth] = useState<StoreHealth[] | null>(null)
  const [challenge, setChallenge] = useState<PhoneChallenge | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [deviceName, setDeviceName] = useState("My phone")
  const [paste, setPaste] = useState("")
  const [scanning, setScanning] = useState(false)
  const [permission, requestPermission] = useCameraPermissions()
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)

  function applySnapshot(next: PhoneSnapshot) {
    setSnap(next)
    setPcName(next.pcName)
  }

  function bind(next: PhoneSession) {
    session.current = next
    next.onOnline(setOnline)
    next.onSnapshot(applySnapshot)
    next.onTask((task) => {
      setSnap((current) => current ? { ...current, tasks: upsert(current.tasks, task) } : current)
    })
    next.onDeleted((id) => {
      setSnap((current) => current ? { ...current, tasks: current.tasks.filter((task) => task.id !== id) } : current)
      setSelected((current) => (current === id ? null : current))
    })
    next.onNotice((notice) => {
      void notify(notice)
    })
    next.onAlerts((alerts) => {
      setSnap((current) => current ? { ...current, alerts } : current)
    })
    next.onChallenge(setChallenge)
  }

  async function connect(link: SavedPhoneLink) {
    if (retry.current) clearTimeout(retry.current)
    session.current?.close()
    const next = new PhoneSession(link)
    bind(next)
    try {
      await next.connect()
      setScreen("dash")
      setError("")
      await ensureNotificationPermission()
    } catch (err) {
      if (err instanceof PhoneRevoked) {
        await clearLink()
        setScreen("pair")
        setError(err.message)
        return
      }
      setOnline(false)
      setScreen("dash")
      setError(err instanceof Error ? err.message : "The PC is offline.")
      retry.current = setTimeout(() => {
        void loadLink().then((saved) => {
          if (saved) void connect(saved)
        })
      }, 4000)
    }
  }

  useEffect(() => {
    if (!challenge) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [challenge])

  useEffect(() => {
    void loadLink().then((link) => {
      if (!link) {
        setScreen("pair")
        return
      }
      setPcName(link.pcName)
      void connect(link)
    }).catch(() => {
      setScreen("pair")
      setError("Saved pairing could not be read. Pair again.")
    })
    return () => {
      if (retry.current) clearTimeout(retry.current)
      session.current?.close()
    }
  }, [])

  async function pairFrom(text: string) {
    setError("")
    try {
      const payload = payloadFromScan(text)
      session.current?.close()
      const next = new PhoneSession()
      bind(next)
      const link = await next.pair(payload, deviceName)
      await saveLink(link)
      setPcName(link.pcName)
      setScreen("dash")
      setScanning(false)
      await ensureNotificationPermission()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pairing failed.")
    }
  }

  async function forget() {
    if (retry.current) clearTimeout(retry.current)
    session.current?.close()
    await clearLink()
    setSnap(null)
    setOnline(false)
    setScreen("pair")
  }

  async function run(action: () => Promise<{ ok: boolean; error?: string; errors?: { id: string; error: string }[] }>) {
    setError("")
    try {
      const result = await action()
      if (!result.ok) setError(result.error || "The PC rejected that.")
      else if (result.errors && result.errors.length) setError(result.errors.map((item) => item.error).join(" "))
    } catch (err) {
      setError(err instanceof Error ? err.message : "The PC is offline.")
    }
  }

  const storeAccounts = snap?.accounts.filter((account) => account.store === draft?.store) ?? []

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      {screen === "boot" ? <ActivityIndicator color={colors.accent} style={styles.boot} /> : null}
      {screen === "pair" ? (
        <ScrollView contentContainerStyle={styles.pad}>
          <Text style={styles.brand}>TCGAIO</Text>
          <Text style={styles.h1}>Pair this phone</Text>
          <Text style={styles.p}>On the PC, open Phone and choose Pair device. Scan that QR code. The PC keeps the card and passwords.</Text>
          {error ? <Text style={styles.err}>{error}</Text> : null}
          <Text style={styles.label}>Name on the PC</Text>
          <TextInput style={styles.input} value={deviceName} onChangeText={setDeviceName} placeholder="My phone" placeholderTextColor={colors.muted} />
          <Pressable style={styles.primary} onPress={() => { void requestPermission().then(() => setScanning(true)) }}>
            <Text style={styles.primaryText}>Scan QR code</Text>
          </Pressable>
          <Text style={styles.label}>Or paste the pairing code</Text>
          <TextInput style={[styles.input, styles.paste]} value={paste} onChangeText={setPaste} multiline autoCapitalize="none" placeholder='{"v":1,...}' placeholderTextColor={colors.muted} />
          <Pressable style={styles.secondary} onPress={() => void pairFrom(paste)}><Text style={styles.secondaryText}>Pair</Text></Pressable>
          {scanning ? (
            <View style={styles.cameraBox}>
              {permission?.granted ? (
                <CameraView
                  style={styles.camera}
                  barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                  onBarcodeScanned={({ data }) => {
                    setScanning(false)
                    void pairFrom(data)
                  }}
                />
              ) : <Text style={styles.p}>Camera permission is required to scan. You can paste the code instead.</Text>}
              <Pressable onPress={() => setScanning(false)}><Text style={styles.link}>Cancel scan</Text></Pressable>
            </View>
          ) : null}
        </ScrollView>
      ) : null}
      {screen === "dash" || screen === "edit" || screen === "alerts" ? (
        <ScrollView contentContainerStyle={styles.pad}>
          <View style={styles.row}>
            <View>
              <Text style={styles.brand}>TCGAIO</Text>
              <Text style={styles.h1}>{pcName}</Text>
            </View>
            <Text style={[styles.pill, online ? styles.pillOn : styles.pillOff]}>{online ? "PC online" : "PC offline"}</Text>
          </View>
          <Text style={styles.p}>Tasks run on the PC. This phone starts, stops, and watches them.</Text>
          {error ? <Text style={styles.err}>{error}</Text> : null}
          {challenge && screen !== "alerts" ? (
            <ChallengeCard challenge={challenge} now={now} session={session.current} onRun={run} />
          ) : null}
          {screen === "alerts" ? (
            <AlertsPanel snap={snap} onRun={run} session={session.current} onBack={() => setScreen("dash")} />
          ) : screen === "edit" && draft ? (
            <View style={styles.card}>
              <Text style={styles.h2}>{draft.id ? "Edit task" : "New task"}</Text>
              <Text style={styles.label}>Store</Text>
              <View style={styles.choices}>
                {(snap?.stores ?? []).map((store) => (
                  <Pressable key={store.id} style={[styles.choice, draft.store === store.id && styles.choiceOn]} onPress={() => setDraft({ ...draft, store: store.id, accountId: "" })}>
                    <Text style={styles.choiceText}>{store.name}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.label}>SKU or URL</Text>
              <TextInput style={styles.input} value={draft.sku} onChangeText={(sku) => setDraft({ ...draft, sku })} autoCapitalize="none" placeholderTextColor={colors.muted} />
              <Text style={styles.label}>Quantity</Text>
              <TextInput style={styles.input} value={String(draft.quantity)} keyboardType="number-pad" onChangeText={(value) => setDraft({ ...draft, quantity: Number(value) || 1 })} />
              <Text style={styles.label}>Profile</Text>
              <View style={styles.choices}>
                {(snap?.profiles ?? []).map((profile) => (
                  <Pressable key={profile.id} style={[styles.choice, draft.profileId === profile.id && styles.choiceOn]} onPress={() => setDraft({ ...draft, profileId: profile.id })}>
                    <Text style={styles.choiceText}>{profile.name} · {profile.last4}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.label}>Account</Text>
              <View style={styles.choices}>
                {storeAccounts.map((account) => (
                  <Pressable key={account.id} style={[styles.choice, draft.accountId === account.id && styles.choiceOn]} onPress={() => setDraft({ ...draft, accountId: account.id })}>
                    <Text style={styles.choiceText}>{account.label} · {account.usernameMasked}</Text>
                  </Pressable>
                ))}
              </View>
              <Text style={styles.label}>Proxy group</Text>
              <View style={styles.choices}>
                <Pressable style={[styles.choice, draft.proxyGroupId === null && styles.choiceOn]} onPress={() => setDraft({ ...draft, proxyGroupId: null })}>
                  <Text style={styles.choiceText}>Direct</Text>
                </Pressable>
                {(snap?.proxyGroups ?? []).map((group) => (
                  <Pressable key={group.id} style={[styles.choice, draft.proxyGroupId === group.id && styles.choiceOn]} onPress={() => setDraft({ ...draft, proxyGroupId: group.id })}>
                    <Text style={styles.choiceText}>{group.name} ({group.count})</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.p}>Test mode. Runs the real flow and stops before place order.</Text>
                <Switch value={draft.testMode === true} onValueChange={(testMode) => setDraft({ ...draft, testMode })} trackColor={{ true: colors.accent, false: colors.line }} />
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.p}>This task may place a real shipping order. Ignored while test mode is on.</Text>
                <Switch value={draft.confirmPurchase} onValueChange={(confirmPurchase) => setDraft({ ...draft, confirmPurchase })} trackColor={{ true: colors.accent, false: colors.line }} />
              </View>
              <View style={styles.row}>
                <Pressable style={styles.primary} onPress={() => void run(async () => {
                  const result = await session.current!.saveTask(draft)
                  if (result.ok) {
                    setScreen("dash")
                    setDraft(null)
                    if (result.task) setSelected(result.task.id)
                  }
                  return result
                })}><Text style={styles.primaryText}>Save</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => { setScreen("dash"); setDraft(null) }}><Text style={styles.secondaryText}>Cancel</Text></Pressable>
              </View>
            </View>
          ) : (
            <>
              {snap?.testMode ? <Text style={styles.p}>Global test mode is on. Every task stops before place order.</Text> : null}
              <View style={styles.row}>
                <Pressable style={styles.primary} onPress={() => { setDraft(emptyDraft(snap)); setScreen("edit"); setError("") }}><Text style={styles.primaryText}>New task</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(() => session.current!.startAll())}><Text style={styles.secondaryText}>Start all</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(() => session.current!.stopAll())}><Text style={styles.secondaryText}>Stop all</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => setScreen("alerts")}><Text style={styles.secondaryText}>Alerts</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(async () => {
                  const result = await session.current!.checkHealth(snap?.proxyGroups[0]?.id ?? null)
                  if (result.ok) setHealth(result.health ?? [])
                  return result
                })}><Text style={styles.secondaryText}>Check stores</Text></Pressable>
              </View>
              {health ? health.map((row) => (
                <Text key={row.store} style={styles.p}>{row.storeName} · {row.proxy} · {row.verdict} · {row.detail}</Text>
              )) : null}
              {(snap?.tasks ?? []).map((item) => (
                <Pressable key={item.id} style={[styles.card, selected === item.id && styles.cardOn]} onPress={() => setSelected(item.id)}>
                  <View style={styles.row}>
                    <Text style={styles.h2}>{item.storeName}</Text>
                    {item.testMode || snap?.testMode ? <Text style={styles.pill}>TEST</Text> : null}
                    <Text style={styles.pill}>{STATUS_LABEL[item.status] ?? item.status}</Text>
                  </View>
                  <Text style={styles.sku}>{item.sku}</Text>
                  <Text style={styles.p}>Qty {item.quantity} · {item.profileName} · {item.accountLabel} · {item.proxyGroupName ?? "Direct"}</Text>
                  {item.detail ? <Text style={styles.p}>{item.detail}</Text> : null}
                  {selected === item.id ? <TaskDetail task={item} onRun={run} session={session.current} onEdit={() => {
                    setDraft({
                      id: item.id,
                      store: item.store,
                      sku: item.sku,
                      quantity: item.quantity,
                      profileId: item.profileId,
                      accountId: item.accountId,
                      proxyGroupId: item.proxyGroupId,
                      confirmPurchase: item.confirmPurchase,
                      testMode: item.testMode
                    })
                    setScreen("edit")
                  }} /> : null}
                </Pressable>
              ))}
              {snap && snap.tasks.length === 0 ? <Text style={styles.p}>No tasks yet. Create one from the profiles and accounts saved on the PC.</Text> : null}
              <Pressable onPress={() => void forget()}><Text style={styles.link}>Forget this PC</Text></Pressable>
            </>
          )}
        </ScrollView>
      ) : null}
    </View>
  )
}

function TaskDetail({ task, onRun, session, onEdit }: {
  task: PhoneTask
  session: PhoneSession | null
  onRun: (action: () => Promise<{ ok: boolean; error?: string }>) => Promise<void>
  onEdit: () => void
}) {
  return (
    <View>
      <View style={styles.row}>
        {isActive(task.status) ? (
          <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.stop(task.id))}><Text style={styles.secondaryText}>Stop</Text></Pressable>
        ) : (
          <Pressable style={styles.primary} onPress={() => void onRun(() => session!.start(task.id))}><Text style={styles.primaryText}>{task.status === "paused" ? "Resume" : "Start"}</Text></Pressable>
        )}
        {!isActive(task.status) ? (
          <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.runTest(task.id))}><Text style={styles.secondaryText}>Run test</Text></Pressable>
        ) : null}
        <Pressable style={styles.secondary} onPress={onEdit}><Text style={styles.secondaryText}>Edit</Text></Pressable>
        <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.deleteTask(task.id))}><Text style={styles.secondaryText}>Delete</Text></Pressable>
      </View>
      {task.logs.map((line, index) => (
        <Text key={`${line.ts}-${index}`} style={styles.log}>{line.message}</Text>
      ))}
    </View>
  )
}

function AlertsPanel({ snap, onRun, session, onBack }: {
  snap: PhoneSnapshot | null
  session: PhoneSession | null
  onRun: (action: () => Promise<{ ok: boolean; error?: string; alerts?: PhoneSnapshot["alerts"] }>) => Promise<void>
  onBack: () => void
}) {
  const alerts = snap?.alerts
  const [rule, setRule] = useState<RestockRuleInput | null>(null)
  const [watch, setWatch] = useState<KeywordWatchInput | null>(null)
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Alerts</Text>
      <Text style={styles.p}>The webhook token stays on the PC. Post store, sku, title, and price. Test mode still stops before place order.</Text>
      {alerts?.localUrl ? <Text style={styles.log}>{alerts.localUrl}</Text> : null}
      {alerts?.relayUrl ? <Text style={styles.log}>{alerts.relayUrl}</Text> : null}
      <Text style={styles.p}>Discord watcher {alerts?.discordWatch ? "on" : "off"}{alerts?.channelId ? ` · ${alerts.channelId}` : ""}</Text>
      {(alerts?.rules ?? []).map((item) => (
        <View key={item.id} style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.h2}>{item.name}</Text>
            {item.testMode || snap?.testMode ? <Text style={styles.pill}>TEST</Text> : null}
            <Switch value={item.enabled} onValueChange={(enabled) => void onRun(() => session!.toggleRule(item.id, enabled))} trackColor={{ true: colors.accent, false: colors.line }} />
          </View>
          <Text style={styles.p}>{item.store || "Any store"} · {item.sku || item.keywords} · max {item.maxQuantity} · {item.maxPrice === null ? "no cap" : `$${item.maxPrice}`}</Text>
          <Pressable onPress={() => void onRun(() => session!.deleteRule(item.id))}><Text style={styles.link}>Delete rule</Text></Pressable>
        </View>
      ))}
      {rule ? (
        <View>
          <Text style={styles.label}>Rule name</Text>
          <TextInput style={styles.input} value={rule.name} onChangeText={(name) => setRule({ ...rule, name })} placeholderTextColor={colors.muted} />
          <Text style={styles.label}>SKU</Text>
          <TextInput style={styles.input} value={rule.sku} onChangeText={(sku) => setRule({ ...rule, sku })} autoCapitalize="none" placeholderTextColor={colors.muted} />
          <Text style={styles.label}>Keywords</Text>
          <TextInput style={styles.input} value={rule.keywords} onChangeText={(keywords) => setRule({ ...rule, keywords })} autoCapitalize="none" placeholder="+elite +trainer -sleeves" placeholderTextColor={colors.muted} />
          <View style={styles.switchRow}>
            <Text style={styles.p}>Test mode</Text>
            <Switch value={rule.testMode} onValueChange={(testMode) => setRule({ ...rule, testMode })} trackColor={{ true: colors.accent, false: colors.line }} />
          </View>
          <Pressable style={styles.primary} onPress={() => void onRun(async () => {
            const result = await session!.saveRule(rule)
            if (result.ok) setRule(null)
            return result
          })}><Text style={styles.primaryText}>Save rule</Text></Pressable>
        </View>
      ) : <Pressable style={styles.secondary} onPress={() => setRule({
        name: "Restock",
        enabled: true,
        store: snap?.stores[0]?.id ?? "target",
        sku: "",
        keywords: "",
        taskId: null,
        profileId: snap?.profiles[0]?.id ?? "",
        accountId: snap?.accounts[0]?.id ?? "",
        proxyGroupId: null,
        quantity: 1,
        maxQuantity: 1,
        maxPrice: null,
        cooldownSec: 300,
        testMode: true,
        confirmPurchase: false
      })}><Text style={styles.secondaryText}>New restock rule</Text></Pressable>}
      <Text style={styles.h2}>Keyword watches</Text>
      {(alerts?.watches ?? []).map((item) => (
        <View key={item.id} style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.h2}>{item.name}</Text>
            <Text style={styles.pill}>{item.status}</Text>
            {item.testMode || snap?.testMode ? <Text style={styles.pill}>TEST</Text> : null}
          </View>
          <Text style={styles.p}>{item.keywords}</Text>
          {item.detail ? <Text style={styles.p}>{item.detail}</Text> : null}
          <View style={styles.row}>
            <Switch value={item.enabled} onValueChange={(enabled) => void onRun(() => session!.toggleWatch(item.id, enabled))} trackColor={{ true: colors.accent, false: colors.line }} />
            {item.status === "blocked" ? <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.resumeWatch(item.id))}><Text style={styles.secondaryText}>Resume</Text></Pressable> : null}
            <Pressable onPress={() => void onRun(() => session!.deleteWatch(item.id))}><Text style={styles.link}>Delete</Text></Pressable>
          </View>
        </View>
      ))}
      {watch ? (
        <View>
          <Text style={styles.label}>Watch name</Text>
          <TextInput style={styles.input} value={watch.name} onChangeText={(name) => setWatch({ ...watch, name })} placeholderTextColor={colors.muted} />
          <Text style={styles.label}>Keywords</Text>
          <TextInput style={styles.input} value={watch.keywords} onChangeText={(keywords) => setWatch({ ...watch, keywords })} autoCapitalize="none" placeholderTextColor={colors.muted} />
          <View style={styles.switchRow}>
            <Text style={styles.p}>Auto-start</Text>
            <Switch value={watch.autoStart === true} onValueChange={(autoStart) => setWatch({ ...watch, autoStart })} trackColor={{ true: colors.accent, false: colors.line }} />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.p}>Test mode</Text>
            <Switch value={watch.testMode === true} onValueChange={(testMode) => setWatch({ ...watch, testMode })} trackColor={{ true: colors.accent, false: colors.line }} />
          </View>
          <Pressable style={styles.primary} onPress={() => void onRun(async () => {
            const result = await session!.saveWatch(watch)
            if (result.ok) setWatch(null)
            return result
          })}><Text style={styles.primaryText}>Save watch</Text></Pressable>
        </View>
      ) : <Pressable style={styles.secondary} onPress={() => setWatch({
        name: "Keywords",
        enabled: true,
        store: "target",
        keywords: "+elite +trainer +box +pokemon -sleeves",
        maxPrice: 60,
        soldByRetailer: true,
        proxyGroupId: null,
        profileId: snap?.profiles[0]?.id ?? "",
        accountId: snap?.accounts.find((account) => account.store === "target")?.id ?? "",
        quantity: 1,
        maxQuantity: 1,
        autoStart: false,
        testMode: true,
        confirmPurchase: false
      })}><Text style={styles.secondaryText}>New keyword watch</Text></Pressable>}
      {(alerts?.log ?? []).slice(0, 12).map((entry) => (
        <Text key={entry.id} style={styles.log}>{entry.source} · {entry.sku} · {entry.result}</Text>
      ))}
      <Pressable onPress={onBack}><Text style={styles.link}>Back to tasks</Text></Pressable>
    </View>
  )
}

function upsert(tasks: PhoneTask[], task: PhoneTask): PhoneTask[] {
  const index = tasks.findIndex((item) => item.id === task.id)
  if (index < 0) return [task, ...tasks]
  const next = tasks.slice()
  next[index] = task
  return next
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  boot: { marginTop: 80 },
  pad: { padding: 20, paddingTop: 56, gap: 12 },
  brand: { color: colors.accent, letterSpacing: 2, fontSize: 12, fontWeight: "700" },
  h1: { color: colors.text, fontSize: 28, fontWeight: "700" },
  h2: { color: colors.text, fontSize: 16, fontWeight: "700" },
  p: { color: colors.muted, fontSize: 14, flexShrink: 1 },
  err: { color: "#ffd0d0", backgroundColor: "#3a1d1d", padding: 10, borderRadius: 8 },
  label: { color: colors.muted, fontSize: 12, marginTop: 8 },
  input: { backgroundColor: colors.card2, color: colors.text, borderColor: colors.line, borderWidth: 1, borderRadius: 8, padding: 10 },
  paste: { minHeight: 80, textAlignVertical: "top" },
  primary: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  primaryText: { color: colors.accentInk, fontWeight: "700" },
  secondary: { borderColor: colors.line, borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  secondaryText: { color: colors.text },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" },
  card: { backgroundColor: colors.card, borderRadius: 10, padding: 14, gap: 8, borderWidth: 1, borderColor: colors.line },
  cardOn: { borderColor: colors.accent },
  sku: { color: colors.text, fontSize: 15 },
  pill: { color: colors.text, backgroundColor: "#2a303b", borderRadius: 99, paddingHorizontal: 8, paddingVertical: 3, overflow: "hidden", fontSize: 12 },
  pillOn: { backgroundColor: "#16362b", color: "#b7f0d6" },
  pillOff: { backgroundColor: "#3d3118", color: "#ffe1a8" },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  choice: { borderColor: colors.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
  choiceOn: { borderColor: colors.accent, backgroundColor: "#2a2418" },
  choiceText: { color: colors.text, fontSize: 13 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 8 },
  log: { color: colors.muted, fontFamily: "monospace", fontSize: 12 },
  link: { color: colors.accent, marginTop: 12 },
  cameraBox: { gap: 8 },
  camera: { height: 280, borderRadius: 12, overflow: "hidden" }
})
