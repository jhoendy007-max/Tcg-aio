import { StatusBar } from "expo-status-bar"
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import { PhoneRevoked, PhoneSession, payloadFromScan, type SavedPhoneLink } from "../src/phone/client"
import type { PhoneChallenge, PhoneSnapshot, PhoneTask, PhoneTaskDraft } from "../src/phone/protocol"
import { ChallengeCard } from "./src/ChallengeCard"
import type { KeywordWatchInput, RestockRuleInput } from "../src/shared/types"
import { ensureNotificationPermission, notify } from "./src/notify"
import { clearLink, loadLink, saveLink } from "./src/storage"
import type { StoreHealth } from "../src/shared/types"
import { SwipeTask } from "./src/SwipeTask"
import { MailPanel } from "./src/MailPanel"
import { ModulePanel } from "./src/ModulePanel"
import { mailText } from "../src/shared/mail-text"
import { moduleText } from "../src/shared/module-settings"
import { updateWidget } from "./src/widget"
import { colors, isActive, palette, STATUS_LABEL } from "./src/theme"
import { countdown } from "../src/shared/clock"
import { isNewer, PHONE_VERSION } from "./src/version"

type Screen = "boot" | "pair" | "dash" | "edit" | "alerts" | "drops" | "stats" | "mail" | "stores"
type Bag = { colors: typeof colors; styles: ReturnType<typeof createStyles> }
const ThemeContext = createContext<Bag>({ colors, styles: createStyles(colors) })
function useTheme() { return useContext(ThemeContext) }

const LETTER: Record<string, string> = { target: "T", walmart: "W", bestbuy: "B", "pokemon-center": "P", amazon: "A", crunchyroll: "C", bandai: "N" }

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
  const [banner, setBanner] = useState("")
  const [noticeImage, setNoticeImage] = useState("")
  const seen = useRef(new Map<string, string>())
  const [permission, requestPermission] = useCameraPermissions()
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)

  function applySnapshot(next: PhoneSnapshot) {
    setSnap(next)
    setPcName(next.brand?.appName || next.pcName)
    const active = next.tasks.filter((task) => isActive(task.status)).length
    updateWidget(next.analytics?.success ?? 0, active)
  }

  function bind(next: PhoneSession) {
    session.current = next
    next.onOnline(setOnline)
    next.onSnapshot(applySnapshot)
    next.onTask((task) => {
      const before = seen.current.get(task.id)
      seen.current.set(task.id, task.status)
      if (before && before !== task.status && (task.status === "success" || task.status === "tested")) {
        setBanner(task.status === "tested" ? `${task.storeName} test finished. Place order was not sent.` : `${task.storeName} checkout confirmed. ${task.sku}`)
      }
      setSnap((current) => current ? { ...current, tasks: upsert(current.tasks, task) } : current)
    })
    next.onDeleted((id) => {
      setSnap((current) => current ? { ...current, tasks: current.tasks.filter((task) => task.id !== id) } : current)
      setSelected((current) => (current === id ? null : current))
    })
    next.onNotice((notice) => {
      void notify(notice)
      const price = typeof notice.price === "number" ? ` · $${notice.price.toFixed(2)}` : ""
      setBanner(`${notice.storeName} · ${notice.sku}${price}\n${notice.detail}`)
      setNoticeImage(notice.imageUrl?.startsWith("https://") ? notice.imageUrl : "")
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
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

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

  async function run(action: () => Promise<{ ok: boolean; error?: string; errors?: { id: string; error: string }[]; csv?: string; created?: number }>) {
    setError("")
    try {
      const result = await action()
      if (!result.ok) setError(result.error || "The PC rejected that.")
      else if (result.errors && result.errors.length) setError(result.errors.map((item) => item.error).join(" "))
      return result
    } catch (err) {
      setError(err instanceof Error ? err.message : "The PC is offline.")
      return { ok: false as const, error: err instanceof Error ? err.message : "The PC is offline." }
    }
  }

  const storeAccounts = snap?.accounts.filter((account) => account.store === draft?.store) ?? []
  const theme = useMemo(() => palette(snap?.brand), [snap?.brand?.theme, snap?.brand?.accent])
  const styles = useMemo(() => createStyles(theme), [theme])
  const activeCount = (snap?.tasks ?? []).filter((task) => isActive(task.status)).length

  return (
    <ThemeContext.Provider value={{ colors: theme, styles }}>
    <View style={styles.root}>
      <StatusBar style={theme.bg === colors.bg ? "light" : "dark"} />
      {screen === "boot" ? <ActivityIndicator color={theme.accent} style={styles.boot} /> : null}
      {screen === "pair" ? (
        <ScrollView contentContainerStyle={styles.pad}>
          <Text style={styles.brand}>TCGAIO</Text>
          <Text style={styles.h1}>Pair this phone</Text>
          <Text style={styles.p}>On the PC, open Phone and choose Pair device. Scan that QR code. The PC keeps the card and passwords.</Text>
          {error ? <Text style={styles.err}>{error}</Text> : null}
          <Text style={styles.label}>Name on the PC</Text>
          <TextInput style={styles.input} value={deviceName} onChangeText={setDeviceName} placeholder="My phone" placeholderTextColor={theme.muted} />
          <Pressable style={styles.primary} onPress={() => { void requestPermission().then(() => setScanning(true)) }}>
            <Text style={styles.primaryText}>Scan QR code</Text>
          </Pressable>
          <Text style={styles.label}>Or paste the pairing code</Text>
          <TextInput style={[styles.input, styles.paste]} value={paste} onChangeText={setPaste} multiline autoCapitalize="none" placeholder='{"v":1,...}' placeholderTextColor={theme.muted} />
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
      {screen === "dash" || screen === "edit" || screen === "alerts" || screen === "drops" || screen === "stats" || screen === "mail" || screen === "stores" ? (
        <ScrollView contentContainerStyle={styles.pad}>
          <View style={styles.row}>
            <View>
              <Text style={styles.brand}>{snap?.brand?.appName || "TCGAIO"}</Text>
              <Text style={styles.h1}>{pcName}</Text>
            </View>
            <Text style={[styles.pill, online ? styles.pillOn : styles.pillOff]}>{online ? "PC online" : "PC offline"}</Text>
          </View>
          <Text style={styles.p}>Tasks run on the PC. This phone starts, stops, and watches them.</Text>
          {error ? <Text style={styles.err}>{error}</Text> : null}
          {banner ? (
            <View style={styles.banner}>
              {noticeImage ? <Image source={{ uri: noticeImage }} style={styles.photo} accessibilityIgnoresInvertColors /> : null}
              <Text accessibilityLiveRegion="polite" style={styles.p}>{banner}</Text>
            </View>
          ) : null}
          {challenge && screen !== "alerts" ? (
            <ChallengeCard challenge={challenge} now={now} session={session.current} onRun={run} />
          ) : null}
          {screen === "mail" ? (
            <MailPanel snap={snap} session={session.current} onRun={run} onBack={() => setScreen("dash")} />
          ) : screen === "stores" ? (
            <ModulePanel snap={snap} session={session.current} onRun={run} onBack={() => setScreen("dash")} />
          ) : screen === "alerts" ? (
            <AlertsPanel snap={snap} onRun={run} session={session.current} onBack={() => setScreen("dash")} />
          ) : screen === "drops" ? (
            <DropsPanel snap={snap} now={now} session={session.current} onRun={run} onBack={() => setScreen("dash")} />
          ) : screen === "stats" ? (
            <StatsPanel snap={snap} session={session.current} onRun={run} onBack={() => setScreen("dash")} />
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
              <TextInput style={styles.input} value={draft.sku} onChangeText={(sku) => setDraft({ ...draft, sku })} autoCapitalize="none" placeholderTextColor={theme.muted} />
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
                <Switch value={draft.testMode === true} onValueChange={(testMode) => setDraft({ ...draft, testMode })} trackColor={{ true: theme.accent, false: theme.line }} />
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.p}>This task may place a real shipping order. Ignored while test mode is on.</Text>
                <Switch value={draft.confirmPurchase} onValueChange={(confirmPurchase) => setDraft({ ...draft, confirmPurchase })} trackColor={{ true: theme.accent, false: theme.line }} />
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
              <View style={styles.metrics}>
                <View style={styles.metric}><Text style={styles.metricNum}>{activeCount}</Text><Text style={styles.p}>Active</Text></View>
                <View style={styles.metric}><Text style={styles.metricNum}>{snap?.analytics?.success ?? 0}</Text><Text style={styles.p}>Wins</Text></View>
                <View style={styles.metric}><Text style={styles.metricNum}>${(snap?.analytics?.spend ?? 0).toFixed(0)}</Text><Text style={styles.p}>Spend</Text></View>
                <View style={styles.metric}><Text style={styles.metricNum}>{Math.round((snap?.analytics?.winRate ?? 0) * 100)}%</Text><Text style={styles.p}>Win rate</Text></View>
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.p}>Autopilot. Restock alerts, keyword hits, and learned restock hours can start a saved template.</Text>
                <Switch value={snap?.autopilot === true} onValueChange={(enabled) => void run(() => session.current!.setAutopilot(enabled))} trackColor={{ true: theme.accent, false: theme.line }} />
              </View>
              {snap && isNewer(snap.updates?.phoneVersion ?? null, PHONE_VERSION) ? <Text style={styles.p}>Phone {snap.updates.phoneVersion} is on the PC's GitHub release. Install that APK over this {PHONE_VERSION} build. The download stays on the PC.</Text> : null}
              {snap?.keeper ? <Text style={styles.p}>Session Keeper {snap.keeper.enabled ? "on" : "off"} · {snap.keeper.saved} signed in · {snap.keeper.expired} need a sign-in · every {snap.keeper.intervalMin} min</Text> : null}
              {snap?.imap ? <Text style={styles.p}>{snap.imap.accounts === 0 ? mailText(snap.language === "es" ? "es" : "en", "statusOff") : `${mailText(snap.language === "es" ? "es" : "en", "statusOn")} ${snap.imap.enabled} · ${snap.imap.ready}${snap.imap.lastError ? ` · ${snap.imap.lastError}` : ""}`}</Text> : null}
              {nextDrop(snap, now) ? <Text style={styles.p}>Next drop {nextDrop(snap, now)}</Text> : null}
              <View style={styles.row}>
                <Pressable style={styles.primary} onPress={() => { setDraft(emptyDraft(snap)); setScreen("edit"); setError("") }}><Text style={styles.primaryText}>New task</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(() => session.current!.startAll())}><Text style={styles.secondaryText}>Start all</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(() => session.current!.pauseAll())}><Text style={styles.secondaryText}>Pause all</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(() => session.current!.stopAll())}><Text style={styles.secondaryText}>Stop all</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => setScreen("mail")}><Text style={styles.secondaryText}>{mailText(snap?.language === "es" ? "es" : "en", "phoneTitle")}</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => setScreen("stores")}><Text style={styles.secondaryText}>{moduleText(snap?.language === "es" ? "es" : "en", "phoneTitle")}</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => setScreen("alerts")}><Text style={styles.secondaryText}>Alerts</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => setScreen("drops")}><Text style={styles.secondaryText}>Drops</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => setScreen("stats")}><Text style={styles.secondaryText}>Stats</Text></Pressable>
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
                <SwipeTask key={item.id} active={isActive(item.status)} onPrimary={() => void run(() => isActive(item.status) ? session.current!.stop(item.id) : session.current!.start(item.id))} onTest={() => void run(() => session.current!.runTest(item.id))}>
                <Pressable style={[styles.card, selected === item.id && styles.cardOn]} onPress={() => setSelected(item.id)} accessibilityHint="Swipe right to start or stop. Swipe left to run a test. Buttons below do the same.">
                  <View style={styles.row}>
                    <View style={[styles.mark, { backgroundColor: theme.accent }]}><Text style={styles.markText}>{LETTER[item.store] ?? "S"}</Text></View>
                    {item.imageUrl?.startsWith("https://") ? <Image source={{ uri: item.imageUrl }} style={styles.photo} accessibilityIgnoresInvertColors /> : null}
                    <Text style={styles.h2}>{item.storeName}</Text>
                    {item.monitorOnly ? <Text style={styles.pill}>MONITOR</Text> : null}
                    {item.testMode || snap?.testMode ? <Text style={styles.pill}>TEST</Text> : null}
                    <Text style={styles.pill}>{STATUS_LABEL[item.status] ?? item.status}</Text>
                  </View>
                  <Text style={styles.sku}>{item.sku}</Text>
                  <Text style={styles.p}>Qty {item.quantity} · {item.profileName} · {item.accountLabel} · {item.proxyGroupName ?? "Direct"}</Text>
                  {typeof item.monitorMs === "number" ? <Text style={styles.p}>{item.monitorMs} ms{typeof item.detectToCartMs === "number" ? ` · ${item.detectToCartMs} ms to cart` : ""}</Text> : null}
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
                </SwipeTask>
              ))}
              {snap && snap.tasks.length === 0 ? <Text style={styles.p}>No tasks yet. Create one from the profiles and accounts saved on the PC.</Text> : null}
              <Pressable onPress={() => void forget()}><Text style={styles.link}>Forget this PC</Text></Pressable>
            </>
          )}
        </ScrollView>
      ) : null}
    </View>
    </ThemeContext.Provider>
  )
}

function nextDrop(snap: PhoneSnapshot | null, now: number): string {
  const next = (snap?.schedules ?? [])
    .filter((schedule) => schedule.enabled && schedule.phase !== "stopped" && schedule.phase !== "started")
    .sort((a, b) => a.startAt - b.startAt)[0]
  if (!next) return ""
  return `${next.name} · ${countdown(next.startAt, now)}`
}

function DropsPanel({ snap, now, session, onRun, onBack }: {
  snap: PhoneSnapshot | null
  now: number
  session: PhoneSession | null
  onRun: (action: () => Promise<{ ok: boolean; error?: string; created?: number }>) => Promise<{ ok: boolean; created?: number } | undefined>
  onBack: () => void
}) {
  const [name, setName] = useState("Drop")
  const [startAt, setStartAt] = useState("")
  const [warmupMin, setWarmupMin] = useState("10")
  const [group, setGroup] = useState("")
  const [text, setText] = useState("")
  const { styles, colors } = useTheme()
  const account = snap?.accounts[0]
  const profile = snap?.profiles[0]
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Drops</Text>
      <Text style={styles.p}>Times are Atlantic Time (Puerto Rico, UTC−4), like 2026-11-13T09:00. Session Keeper warms accounts before the start. The phone is notified.</Text>
      {(snap?.schedules ?? []).map((schedule) => (
        <View key={schedule.id} style={styles.card}>
          <Text style={styles.h2}>{schedule.name}</Text>
          <Text style={styles.p}>{schedule.phase} · {countdown(schedule.startAt, now)} · warm {schedule.warmupMin} min{schedule.group ? ` · ${schedule.group}` : ""}</Text>
          <Pressable onPress={() => void onRun(() => session!.deleteSchedule(schedule.id))}><Text style={styles.link}>Delete</Text></Pressable>
        </View>
      ))}
      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} />
      <Text style={styles.label}>Start</Text>
      <TextInput style={styles.input} value={startAt} onChangeText={setStartAt} placeholder="2026-11-13T09:00" placeholderTextColor={colors.muted} autoCapitalize="none" />
      <Text style={styles.label}>Warm-up minutes</Text>
      <TextInput style={styles.input} value={warmupMin} onChangeText={setWarmupMin} keyboardType="number-pad" />
      <Text style={styles.label}>Task group</Text>
      <TextInput style={styles.input} value={group} onChangeText={setGroup} placeholder="ETB" placeholderTextColor={colors.muted} />
      <Pressable style={styles.primary} onPress={() => void onRun(() => session!.saveSchedule({ name, startAt, stopAt: "", warmupMin: Number(warmupMin), group, taskIds: [] }))}><Text style={styles.primaryText}>Schedule</Text></Pressable>
      <Text style={styles.h2}>Paste SKUs</Text>
      <TextInput style={[styles.input, styles.area]} value={text} onChangeText={setText} multiline placeholder="One SKU or URL per line" placeholderTextColor={colors.muted} />
      <Pressable style={styles.secondary} onPress={() => void onRun(async () => {
        if (!account || !profile) return { ok: false, error: "Save a profile and account on the PC first." }
        return session!.bulkTasks({ text, store: account.store, quantity: 1, profileId: profile.id, accountId: account.id, proxyGroupId: null, confirmPurchase: false, testMode: snap?.testMode === true, group })
      })}><Text style={styles.secondaryText}>Create tasks</Text></Pressable>
      <Pressable onPress={onBack}><Text style={styles.link}>Back</Text></Pressable>
    </View>
  )
}

function StatsPanel({ snap, session, onRun, onBack }: {
  snap: PhoneSnapshot | null
  session: PhoneSession | null
  onRun: (action: () => Promise<{ ok: boolean; error?: string; csv?: string }>) => Promise<{ ok: boolean; csv?: string } | undefined>
  onBack: () => void
}) {
  const { styles } = useTheme()
  const [csv, setCsv] = useState("")
  const stats = snap?.analytics
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Analytics</Text>
      <Text style={styles.p}>Win rate {Math.round((stats?.winRate ?? 0) * 100)}% · spend ${ (stats?.spend ?? 0).toFixed(2) } · {stats?.success ?? 0} success · {stats?.failure ?? 0} failed · {stats?.paused ?? 0} paused · {stats?.tested ?? 0} tested</Text>
      <Text style={styles.p}>Monitor {stats?.monitorSamples ?? 0} reads · avg {stats?.monitorAvgMs ?? 0} ms · p50 {stats?.monitorP50Ms ?? 0} ms · p95 {stats?.monitorP95Ms ?? 0} ms · block rate {Math.round((stats?.monitorBlockRate ?? 0) * 100)}%</Text>
      {(stats?.byStore ?? []).map((row) => (
        <Text key={row.store} style={styles.p}>{row.storeName} · {row.success} won · {row.failure} failed · ${row.spend.toFixed(2)}</Text>
      ))}
      {(stats?.recent ?? []).map((row) => (
        <Text key={`${row.at}-${row.sku}`} style={styles.log}>{row.outcome} · {row.storeName} · {row.sku}{row.price === null ? "" : ` · $${row.price.toFixed(2)}`}</Text>
      ))}
      <Pressable style={styles.secondary} onPress={() => void onRun(async () => {
        const result = await session!.analyticsCsv()
        if (result.ok && result.csv) setCsv(result.csv)
        return result
      })}><Text style={styles.secondaryText}>Show CSV</Text></Pressable>
      {csv ? <Text style={styles.log} selectable>{csv.slice(0, 4000)}</Text> : null}
      <Pressable onPress={onBack}><Text style={styles.link}>Back</Text></Pressable>
    </View>
  )
}

function TaskDetail({ task, onRun, session, onEdit }: {
  task: PhoneTask
  session: PhoneSession | null
  onRun: (action: () => Promise<{ ok: boolean; error?: string }>) => Promise<unknown>
  onEdit: () => void
}) {
  const { styles } = useTheme()
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
        <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.openAccountLogin(task.accountId))}><Text style={styles.secondaryText}>Sign in on PC</Text></Pressable>
        <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.duplicateTask(task.id))}><Text style={styles.secondaryText}>Duplicate</Text></Pressable>
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
  onRun: (action: () => Promise<{ ok: boolean; error?: string; alerts?: PhoneSnapshot["alerts"] }>) => Promise<unknown>
  onBack: () => void
}) {
  const { styles, colors } = useTheme()
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

function createStyles(c: typeof colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.bg },
    boot: { marginTop: 80 },
    pad: { padding: 20, paddingTop: 56, gap: 12 },
    brand: { color: c.accent, letterSpacing: 2, fontSize: 12, fontWeight: "700" },
    h1: { color: c.text, fontSize: 28, fontWeight: "700" },
    h2: { color: c.text, fontSize: 16, fontWeight: "700" },
    p: { color: c.muted, fontSize: 14, flexShrink: 1 },
    err: { color: "#ffd0d0", backgroundColor: "#3a1d1d", padding: 10, borderRadius: 8 },
    banner: { color: c.text, backgroundColor: c.card, borderColor: c.accent, borderWidth: 1, padding: 10, borderRadius: 8 },
    label: { color: c.muted, fontSize: 12, marginTop: 8 },
    input: { backgroundColor: c.card2, color: c.text, borderColor: c.line, borderWidth: 1, borderRadius: 8, padding: 10 },
    area: { minHeight: 90, textAlignVertical: "top" },
    paste: { minHeight: 80, textAlignVertical: "top" },
    primary: { backgroundColor: c.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
    primaryText: { color: c.accentInk, fontWeight: "700" },
    secondary: { borderColor: c.line, borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
    secondaryText: { color: c.text },
    row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" },
    card: { backgroundColor: c.card, borderRadius: 10, padding: 14, gap: 8, borderWidth: 1, borderColor: c.line },
    cardOn: { borderColor: c.accent },
    sku: { color: c.text, fontSize: 15 },
    pill: { color: c.text, backgroundColor: "#2a303b", borderRadius: 99, paddingHorizontal: 8, paddingVertical: 3, overflow: "hidden", fontSize: 12 },
    pillOn: { backgroundColor: "#16362b", color: "#b7f0d6" },
    pillOff: { backgroundColor: "#3d3118", color: "#ffe1a8" },
    choices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    choice: { borderColor: c.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8 },
    choiceOn: { borderColor: c.accent, backgroundColor: c.wash },
    choiceText: { color: c.text, fontSize: 13 },
    switchRow: { flexDirection: "row", alignItems: "center", gap: 12, marginTop: 8 },
    log: { color: c.muted, fontFamily: "monospace", fontSize: 12 },
    link: { color: c.accent, marginTop: 12 },
    cameraBox: { gap: 8 },
    camera: { height: 280, borderRadius: 12, overflow: "hidden" },
    metrics: { flexDirection: "row", gap: 8 },
    metric: { flex: 1, backgroundColor: c.card, borderRadius: 10, padding: 10, borderWidth: 1, borderColor: c.line },
    metricNum: { color: c.text, fontSize: 18, fontWeight: "700" },
    mark: { width: 28, height: 28, borderRadius: 8, alignItems: "center", justifyContent: "center" },
    markText: { color: c.accentInk, fontWeight: "700" },
    photo: { width: 36, height: 36, borderRadius: 8 }
  })
}
