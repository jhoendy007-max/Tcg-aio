import { StatusBar } from "expo-status-bar"
import { stockOfLine, stockOfTask, type StockState } from "../src/shared/stock"
import { useEffect, useMemo, useRef, useState } from "react"
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native"
import { CameraView, useCameraPermissions } from "expo-camera"
import { PhoneRevoked, PhoneSession, payloadFromScan, type SavedPhoneLink } from "../src/phone/client"
import type { PhoneChallenge, PhoneSnapshot, PhoneTask, PhoneTaskDraft } from "../src/phone/protocol"
import { ChallengeCard } from "./src/ChallengeCard"
import type { KeywordWatchInput, RestockRuleInput } from "../src/shared/types"
import { ensureNotificationPermission, notify } from "./src/notify"
import { activeLink } from "../src/phone/links"
import { clearLink, forgetPcLink, loadBook, loadLink, saveLink, selectPc } from "./src/storage"
import type { StoreHealth } from "../src/shared/types"
import { SwipeTask } from "./src/SwipeTask"
import { MailPanel } from "./src/MailPanel"
import { ModulePanel } from "./src/ModulePanel"
import { mailText } from "../src/shared/mail-text"
import { moduleText } from "../src/shared/module-settings"
import { taskText } from "../src/shared/task-role"
import { updateWidget } from "./src/widget"
import { colors, isActive, palette, STATUS_LABEL } from "./src/theme"
import { ThemeContext, useTheme } from "./src/theme-context"
import { DeskPanel, LogsPanel, PhoneSettingsForm } from "./src/Desk"
import { PhoneUpdateCard } from "./src/PhoneUpdateCard"
import { PhoneUpdatePrompt } from "./src/UpdatePrompt"
import { countdown } from "../src/shared/clock"
import { isNewer, PHONE_VERSION } from "./src/version"
import { asList, draftFromPhoneTask, emptyPhoneDraft, phoneTaskStatus, textField, withStoreDefaults } from "../src/phone/task-draft"
import { isStoreId } from "../src/shared/stores"

type Screen = "boot" | "pair" | "dash" | "edit" | "alerts" | "drops" | "stats" | "mail" | "stores"
type PhoneTab = "tasks" | "accounts" | "clients" | "settings"

const LETTER: Record<string, string> = { target: "T", walmart: "W", bestbuy: "B", "pokemon-center": "P", amazon: "A", crunchyroll: "C", bandai: "N", gamestop: "G", "barnes-noble": "BN", costco: "Co", sams: "S", tcgplayer: "D" }


export default function App() {
  const session = useRef<PhoneSession | null>(null)
  const [screen, setScreen] = useState<Screen>("boot")
  const [online, setOnline] = useState(false)
  const [pcName, setPcName] = useState("Zzz AIO")
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
  const [links, setLinks] = useState<SavedPhoneLink[]>([])
  const [roleFilter, setRoleFilter] = useState<"" | "monitor" | "checkout">("")
  const [tab, setTab] = useState<PhoneTab>("tasks")
  const seen = useRef(new Map<string, string>())
  const [permission, requestPermission] = useCameraPermissions()
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)

  function applySnapshot(next: PhoneSnapshot) {
    const tasks = asList<PhoneTask>(next?.tasks)
    setSnap({ ...next, tasks })
    setPcName(next?.brand?.appName || next?.pcName || "Zzz AIO")
    const active = tasks.filter((task) => isActive(task.status)).length
    updateWidget(next?.analytics?.success ?? 0, active)
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
      if (before !== task.status && (task.status === "challenge" || task.status === "in_queue")) {
        const text = task.status === "challenge"
          ? `${task.storeName} needs a person on the PC. ${task.detail || "Solve the check on the desktop window."}`
          : `${task.storeName} is in a store queue. Open the PC if it asks a person to continue.`
        setBanner(text)
        void notify({
          kind: task.status === "challenge" ? "challenge" : "paused",
          storeName: task.storeName,
          sku: task.sku,
          profileName: task.profileName,
          detail: text,
          ts: Date.now()
        })
      }
      setSnap((current) => current ? { ...current, tasks: upsert(asList<PhoneTask>(current.tasks), task) } : current)
    })
    next.onDeleted((id) => {
      setSnap((current) => current ? { ...current, tasks: asList<PhoneTask>(current.tasks).filter((task) => task.id !== id) } : current)
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
        const book = await forgetPcLink(link.pcId)
        setLinks(book.links)
        const next = activeLink(book)
        setError(err.message)
        if (next) {
          setPcName(next.pcName)
          void connect(next)
          return
        }
        setScreen("pair")
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
    void loadBook().then((book) => {
      setLinks(book.links)
      const link = activeLink(book)
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
      const book = await saveLink(link)
      setLinks(book.links)
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
    const book = await clearLink()
    setLinks(book.links)
    const next = activeLink(book)
    setSnap(null)
    setOnline(false)
    if (next) {
      setPcName(next.pcName)
      void connect(next)
      return
    }
    setScreen("pair")
  }

  async function switchPc(pcId: string) {
    if (retry.current) clearTimeout(retry.current)
    const book = await selectPc(pcId)
    setLinks(book.links)
    const next = activeLink(book)
    if (!next) return
    setPcName(next.pcName)
    setSnap(null)
    void connect(next)
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
          <Image source={require("./assets/icon.png")} style={{ width: 40, height: 40, borderRadius: 10, marginBottom: 8 }} accessibilityLabel="Zzz logo" />
          <Text style={styles.brand}>Zzz APP</Text>
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
          {links.length ? <Text style={styles.label}>Saved PCs</Text> : null}
          {links.map((item) => (
            <Pressable key={item.pcId} onPress={() => void switchPc(item.pcId)}><Text style={styles.link}>{item.pcName}</Text></Pressable>
          ))}
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
            <Image source={require("./assets/icon.png")} style={{ width: 40, height: 40, borderRadius: 10, marginRight: 10 }} accessibilityLabel="Zzz logo" />
            <View style={{ flex: 1 }}>
              <Text style={styles.brand}>{snap?.brand?.appName || "Zzz APP"}</Text>
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
            <TaskEditor draft={draft} snap={snap} setDraft={setDraft} session={session.current} run={run} onSaved={(id) => { setScreen("dash"); setDraft(null); if (id) setSelected(id) }} onCancel={() => { setScreen("dash"); setDraft(null) }} />
          ) : (
            <>
              {tab === "tasks" ? <>
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
              {snap?.accountPending ? <Text style={styles.p}>This PC is waiting for activation. Tasks stay off until a license is linked.</Text> : null}
              {snap && isNewer(snap.updates?.phoneVersion ?? null, PHONE_VERSION) ? <Text style={styles.p}>Phone {snap.updates.phoneVersion} is on the PC's GitHub release. Install that APK over this {PHONE_VERSION} build. The download stays on the PC.</Text> : null}
              {snap?.keeper ? <Text style={styles.p}>Session Keeper {snap.keeper.enabled ? "on" : "off"} · {snap.keeper.saved} signed in · {snap.keeper.expired} need a sign-in · every {snap.keeper.intervalMin} min</Text> : null}
              {snap?.imap ? <Text style={styles.p}>{snap.imap.accounts === 0 ? mailText(snap.language === "es" ? "es" : "en", "statusOff") : `${mailText(snap.language === "es" ? "es" : "en", "statusOn")} ${snap.imap.enabled} · ${snap.imap.ready}${snap.imap.lastError ? ` · ${snap.imap.lastError}` : ""}`}</Text> : null}
              {nextDrop(snap, now) ? <Text style={styles.p}>Next drop {nextDrop(snap, now)}</Text> : null}
              <View style={styles.choices}>
                {(["", "monitor", "checkout"] as const).map((kind) => (
                  <Pressable key={kind || "all"} style={[styles.choice, roleFilter === kind && styles.choiceOn]} onPress={() => setRoleFilter(kind)}>
                    <Text style={styles.choiceText}>{kind === "" ? (snap?.language === "es" ? "Todas" : "All") : taskText(snap?.language === "es" ? "es" : "en", kind)}</Text>
                  </Pressable>
                ))}
              </View>
              <View style={styles.row}>
                <Pressable style={styles.primary} onPress={() => {
                  try {
                    setDraft(emptyPhoneDraft(snap))
                    setScreen("edit")
                    setError("")
                  } catch (err) {
                    console.error(err)
                    setError(err instanceof Error ? err.message : "Could not open a new task.")
                  }
                }}><Text style={styles.primaryText}>Create task</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(() => session.current!.startAll())}><Text style={styles.secondaryText}>Start all</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(() => session.current!.pauseAll())}><Text style={styles.secondaryText}>Pause all</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(() => session.current!.stopAll())}><Text style={styles.secondaryText}>Stop all</Text></Pressable>
                <Pressable style={styles.secondary} onPress={() => void run(async () => {
                  const result = await session.current!.checkHealth(asList<{ id?: string }>(snap?.proxyGroups)[0]?.id ?? null)
                  if (result.ok) setHealth(result.health ?? [])
                  return result
                })}><Text style={styles.secondaryText}>Check stores</Text></Pressable>
              </View>
              {health ? health.map((row) => (
                <Text key={row.store} style={styles.p}>{row.storeName} · {row.proxy} · {row.verdict} · {row.detail}</Text>
              )) : null}
              </> : null}
              {tab === "accounts" ? <><Text style={styles.h1}>Accounts</Text><DeskPanel snap={snap} session={session.current} run={run} focus="people" /></> : null}
              {tab === "clients" ? <><Text style={styles.h1}>ACO</Text><DeskPanel snap={snap} session={session.current} run={run} focus="clients" /></> : null}
              {tab === "settings" ? <><Text style={styles.h1}>Settings</Text><PhoneSettingsForm snap={snap} session={session.current} run={run} /><PhoneUpdateCard /><LogsPanel snap={snap} />
                <View style={styles.row}>
                  <Pressable style={styles.secondary} onPress={() => setScreen("mail")}><Text style={styles.secondaryText}>{mailText(snap?.language === "es" ? "es" : "en", "phoneTitle")}</Text></Pressable>
                  <Pressable style={styles.secondary} onPress={() => setScreen("stores")}><Text style={styles.secondaryText}>{moduleText(snap?.language === "es" ? "es" : "en", "phoneTitle")}</Text></Pressable>
                  <Pressable style={styles.secondary} onPress={() => setScreen("alerts")}><Text style={styles.secondaryText}>Alerts</Text></Pressable>
                  <Pressable style={styles.secondary} onPress={() => setScreen("drops")}><Text style={styles.secondaryText}>Drops</Text></Pressable>
                  <Pressable style={styles.secondary} onPress={() => setScreen("stats")}><Text style={styles.secondaryText}>Stats</Text></Pressable>
                </View>
              </> : null}
              {(tab === "tasks" ? (snap?.tasks ?? []).filter((item) => {
                if (roleFilter === "") return true
                return roleFilter === "monitor" ? item.kind === "monitor" || item.monitorOnly : item.kind !== "monitor" && !item.monitorOnly
              }) : []).map((item) => (
                <SwipeTask key={item.id} active={isActive(item.status)} onPrimary={() => void run(() => isActive(item.status) ? session.current!.stop(item.id) : session.current!.start(item.id))} onTest={() => void run(() => session.current!.runTest(item.id))}>
                <Pressable style={[styles.card, selected === item.id && styles.cardOn]} onPress={() => setSelected(item.id)} accessibilityHint="Swipe right to start or stop. Swipe left to run a test. Buttons below do the same.">
                  <View style={styles.row}>
                    <View style={[styles.mark, { backgroundColor: theme.accent }]}><Text style={styles.markText}>{LETTER[item.store] ?? "S"}</Text></View>
                    {item.imageUrl?.startsWith("https://") ? <Image source={{ uri: item.imageUrl }} style={styles.photo} accessibilityIgnoresInvertColors /> : null}
                    <Text style={styles.h2}>{item.storeName}</Text>
                    <Text style={styles.pill}>{taskText(snap?.language === "es" ? "es" : "en", item.kind === "monitor" || item.monitorOnly ? "roleBadgeMonitor" : "roleBadgeCheckout")}</Text>
                    {item.testMode || snap?.testMode ? <Text style={styles.pill}>TEST</Text> : null}
                    <Text style={[styles.pill, { color: stockColor(stockOfTask(item)) ?? statusColor(item.status) }, stockOfTask(item) ? { textShadowColor: stockColor(stockOfTask(item)), textShadowRadius: 8 } : null]}>{stockOfTask(item) === "in" ? "In stock" : stockOfTask(item) === "out" ? "Out of stock" : STATUS_LABEL[item.status] ?? item.status}</Text>
                  </View>
                  <Text style={styles.sku}>{item.sku}</Text>
                  <Text style={styles.p}>Qty {item.quantity} · {item.profileName} · {item.accountLabel} · {item.proxyGroupName ?? "Direct"}</Text>
                  {typeof item.monitorMs === "number" ? <Text style={styles.p}>{item.monitorMs} ms{typeof item.detectToCartMs === "number" ? ` · ${item.detectToCartMs} ms to cart` : ""}</Text> : null}
                  {item.detail ? <Text style={styles.p}>{item.detail}</Text> : null}
                  {selected === item.id ? <TaskDetail task={item} onRun={run} session={session.current} onEdit={() => { setDraft(draftFromPhoneTask(item)); setScreen("edit") }} /> : null}
                </Pressable>
                </SwipeTask>
              ))}
 {tab === "tasks" && snap && asList(snap.tasks).length === 0 ? <Text style={styles.p}>No tasks yet. Create one from the profiles and accounts saved on the PC.</Text> : null}
              {links.length > 1 ? (
                <View style={styles.row}>
                  {links.map((item) => (
                    <Pressable key={item.pcId} onPress={() => void switchPc(item.pcId)}><Text style={styles.pill}>{item.pcName}</Text></Pressable>
                  ))}
                </View>
              ) : null}
              <Pressable onPress={() => void forget()}><Text style={styles.link}>Forget this PC</Text></Pressable>
            </>
          )}
        </ScrollView>
      ) : null}
      {screen !== "boot" && screen !== "pair" ? (
        <View style={styles.tabBar}>
          {([
            ["tasks", "Tasks"],
            ["accounts", "Accounts"],
            ["clients", "ACO"],
            ["settings", "Settings"]
          ] as const).map(([id, label]) => (
            <Pressable key={id} style={styles.tab} onPress={() => { setTab(id); if (screen !== "dash" && screen !== "edit") setScreen("dash") }}>
              <Text style={[styles.tabText, tab === id && (screen === "dash" || screen === "edit") && styles.tabOn]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <PhoneUpdatePrompt tasks={snap?.tasks ?? []} />
    </View>
    </ThemeContext.Provider>
  )
}

function TaskEditor({ draft, snap, setDraft, session, run, onSaved, onCancel }: {
  draft: PhoneTaskDraft
  snap: PhoneSnapshot | null
  setDraft: (next: PhoneTaskDraft) => void
  session: PhoneSession | null
  run: (action: () => Promise<{ ok: boolean; error?: string; task?: PhoneTask }>) => Promise<{ ok: boolean; task?: PhoneTask } | undefined>
  onSaved: (id?: string) => void
  onCancel: () => void
}) {
  const { styles, colors: theme } = useTheme()
  const lang = snap?.language === "es" ? "es" : "en"
  const monitor = draft.kind === "monitor"
  const live = Boolean(draft.id && isActive(phoneTaskStatus(snap, draft.id)))
  const accounts = asList<PhoneSnapshot["accounts"][number]>(snap?.accounts).filter((account) => account?.store === draft.store)
  const tasks = asList<PhoneTask>(snap?.tasks)
  const checkouts = tasks.filter((task) => task && task.kind !== "monitor" && task.id !== draft.id)
  const monitors = tasks.filter((task) => task && (task.kind === "monitor" || task.monitorOnly) && task.store === draft.store && task.id !== draft.id)
  const stores = asList<PhoneSnapshot["stores"][number]>(snap?.stores)
  const profiles = asList<PhoneSnapshot["profiles"][number]>(snap?.profiles)
  const proxyGroups = asList<PhoneSnapshot["proxyGroups"][number]>(snap?.proxyGroups)
  const modes = ["manual", "scheduled", "monitor", "restock", "builtin"] as const
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>{draft.id ? (lang === "es" ? "Editar tarea" : "Edit task") : (lang === "es" ? "Nueva tarea" : "New task")}</Text>
      <Text style={styles.p}>{monitor ? taskText(lang, "hintMonitor") : taskText(lang, "hintCheckout")}</Text>
      {live ? <Text style={styles.p}>{taskText(lang, "live")}</Text> : null}
      <Text style={styles.label}>{taskText(lang, "kind")}</Text>
      <View style={styles.choices}>
        {(["monitor", "checkout"] as const).map((kind) => (
          <Pressable key={kind} disabled={live} accessibilityRole="button" accessibilityState={{ selected: draft.kind === kind }} style={[styles.choice, draft.kind === kind && styles.choiceOn]} onPress={() => setDraft(withStoreDefaults({ ...draft, kind }, snap?.storeRoles, kind))}>
            <Text style={styles.choiceText}>{taskText(lang, kind)}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.label}>{taskText(lang, "store")}</Text>
      <View style={styles.choices}>
        {stores.map((store) => (
          <Pressable key={store.id} disabled={live} style={[styles.choice, draft.store === store.id && styles.choiceOn]} onPress={() => setDraft(withStoreDefaults({ ...draft, store: store.id, accountId: "" }, snap?.storeRoles, draft.kind === "monitor" ? "monitor" : "checkout"))}>
            <Text style={styles.choiceText}>{store.name}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={styles.label}>{taskText(lang, "sku")}</Text>
      <TextInput style={styles.input} editable={!live} value={textField(draft.sku)} onChangeText={(sku) => setDraft({ ...draft, sku })} autoCapitalize="none" placeholderTextColor={theme.muted} />
      <Text style={styles.label}>{taskText(lang, "keywords")}</Text>
      <TextInput style={styles.input} value={textField(draft.keywords)} onChangeText={(keywords) => setDraft({ ...draft, keywords })} autoCapitalize="none" placeholderTextColor={theme.muted} />
      {monitor ? (
        <>
          <Text style={styles.p}>{taskText(lang, "monitorAnonymous")}</Text>
          <Text style={styles.label}>{taskText(lang, "monitorDelay")}</Text>
          <TextInput style={styles.input} value={draft.overrides?.monitorDelayMs == null ? "" : String(draft.overrides.monitorDelayMs)} keyboardType="number-pad" onChangeText={(value) => {
            const overrides = { ...draft.overrides }
            if (!value.trim()) delete overrides.monitorDelayMs
            else overrides.monitorDelayMs = Math.round(Number(value))
            setDraft({ ...draft, overrides })
          }} placeholder={taskText(lang, "inherit")} placeholderTextColor={theme.muted} />
          <Text style={styles.label}>{taskText(lang, "proxy")}</Text>
          <View style={styles.choices}>
            <Pressable disabled={live} style={[styles.choice, !draft.monitorProxyGroupId && styles.choiceOn]} onPress={() => setDraft({ ...draft, monitorProxyGroupId: null, proxyGroupId: null })}>
              <Text style={styles.choiceText}>{taskText(lang, "direct")}</Text>
            </Pressable>
            {proxyGroups.map((group) => (
              <Pressable key={group.id} disabled={live} style={[styles.choice, draft.monitorProxyGroupId === group.id && styles.choiceOn]} onPress={() => setDraft({ ...draft, monitorProxyGroupId: group.id, proxyGroupId: null })}>
                <Text style={styles.choiceText}>{group.name}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>{taskText(lang, "priceCap")}</Text>
          <TextInput style={styles.input} value={draft.priceCap == null ? "" : String(draft.priceCap)} keyboardType="decimal-pad" onChangeText={(value) => setDraft({ ...draft, priceCap: value.trim() === "" ? null : Number(value) })} placeholderTextColor={theme.muted} />
          <Text style={styles.label}>{taskText(lang, "webhook")}</Text>
          <TextInput style={styles.input} value={textField(draft.webhook)} onChangeText={(webhook) => setDraft({ ...draft, webhook })} autoCapitalize="none" placeholder="https://discord.com/api/webhooks/" placeholderTextColor={theme.muted} />
          <Text style={styles.label}>{taskText(lang, "hours")}</Text>
          <TextInput style={styles.input} value={textField(draft.activeHours)} onChangeText={(activeHours) => setDraft({ ...draft, activeHours })} autoCapitalize="none" placeholder="09:00-09:30" placeholderTextColor={theme.muted} />
          <Text style={styles.label}>{taskText(lang, "links")}</Text>
          <View style={styles.choices}>
            {checkouts.map((task) => {
              const on = (draft.linkedCheckoutIds ?? []).includes(task.id)
              return (
                <Pressable key={task.id} style={[styles.choice, on && styles.choiceOn]} onPress={() => {
                  const ids = new Set(draft.linkedCheckoutIds ?? [])
                  if (on) ids.delete(task.id)
                  else ids.add(task.id)
                  setDraft({ ...draft, linkedCheckoutIds: [...ids] })
                }}>
                  <Text style={styles.choiceText}>{task.sku}</Text>
                </Pressable>
              )
            })}
          </View>
        </>
      ) : (
        <>
          <Text style={styles.label}>{taskText(lang, "quantity")}</Text>
          <TextInput style={styles.input} editable={!live} value={textField(draft.quantity || 1)} keyboardType="number-pad" onChangeText={(value) => setDraft({ ...draft, quantity: Number(value) || 1 })} placeholderTextColor={theme.muted} />
          <Text style={styles.label}>{taskText(lang, "profile")}</Text>
          <View style={styles.choices}>
            {profiles.map((profile) => (
              <Pressable key={profile.id} disabled={live} style={[styles.choice, draft.profileId === profile.id && styles.choiceOn]} onPress={() => setDraft({ ...draft, profileId: profile.id })}>
                <Text style={styles.choiceText}>{profile.name} · {profile.last4}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>{taskText(lang, "account")}</Text>
          <View style={styles.choices}>
            {accounts.map((account) => (
              <Pressable key={account.id} disabled={live} style={[styles.choice, draft.accountId === account.id && styles.choiceOn]} onPress={() => setDraft({ ...draft, accountId: account.id })}>
                <Text style={styles.choiceText}>{account.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>{taskText(lang, "checkoutProxy")}</Text>
          <View style={styles.choices}>
            <Pressable disabled={live} style={[styles.choice, draft.proxyGroupId === null && styles.choiceOn]} onPress={() => setDraft({ ...draft, proxyGroupId: null })}>
              <Text style={styles.choiceText}>{taskText(lang, "direct")}</Text>
            </Pressable>
            {proxyGroups.map((group) => (
              <Pressable key={group.id} disabled={live} style={[styles.choice, draft.proxyGroupId === group.id && styles.choiceOn]} onPress={() => setDraft({ ...draft, proxyGroupId: group.id })}>
                <Text style={styles.choiceText}>{group.name}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>{taskText(lang, "checkoutDelay")}</Text>
          <TextInput style={styles.input} value={draft.checkoutDelayMs == null ? "" : String(draft.checkoutDelayMs)} keyboardType="number-pad" onChangeText={(value) => setDraft({ ...draft, checkoutDelayMs: value.trim() === "" ? null : Number(value) })} placeholderTextColor={theme.muted} />
          <Text style={styles.label}>{taskText(lang, "maxPrice")}</Text>
          <TextInput style={styles.input} value={draft.maxPrice == null ? "" : String(draft.maxPrice)} keyboardType="decimal-pad" onChangeText={(value) => setDraft({ ...draft, maxPrice: value.trim() === "" ? null : Number(value) })} placeholderTextColor={theme.muted} />
          <Text style={styles.label}>{taskText(lang, "startMode")}</Text>
          <View style={styles.choices}>
            {modes.map((mode) => (
              <Pressable key={mode} disabled={live} style={[styles.choice, (draft.startMode ?? "builtin") === mode && styles.choiceOn]} onPress={() => setDraft({ ...draft, startMode: mode, linkedMonitorId: mode === "monitor" ? draft.linkedMonitorId ?? null : null })}>
                <Text style={styles.choiceText}>{taskText(lang, mode === "monitor" ? "monitorStart" : mode)}</Text>
              </Pressable>
            ))}
          </View>
          {draft.startMode === "monitor" ? (
            <>
              <Text style={styles.label}>{taskText(lang, "linkMonitor")}</Text>
              <Text style={styles.p}>{taskText(lang, "linkMonitorHint")}</Text>
              <View style={styles.choices}>
                <Pressable disabled={live} style={[styles.choice, !draft.linkedMonitorId && styles.choiceOn]} onPress={() => setDraft({ ...draft, linkedMonitorId: null })}>
                  <Text style={styles.choiceText}>{taskText(lang, "noMonitor")}</Text>
                </Pressable>
                {monitors.map((task) => (
                  <Pressable key={task.id} disabled={live} style={[styles.choice, draft.linkedMonitorId === task.id && styles.choiceOn]} onPress={() => setDraft({ ...draft, linkedMonitorId: task.id })}>
                    <Text style={styles.choiceText}>{task.sku || task.keywords || task.id}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : null}
          <View style={styles.switchRow}>
            <Text style={styles.p}>{taskText(lang, "testMode")}</Text>
            <Switch value={draft.testMode === true} disabled={live && draft.testMode === true} onValueChange={(testMode) => setDraft({ ...draft, testMode })} trackColor={{ true: theme.accent, false: theme.line }} />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.p}>{taskText(lang, "confirm")}</Text>
            <Switch value={draft.confirmPurchase} disabled={live && !draft.confirmPurchase} onValueChange={(confirmPurchase) => setDraft({ ...draft, confirmPurchase })} trackColor={{ true: theme.accent, false: theme.line }} />
          </View>
        </>
      )}
      <Text style={styles.label}>{taskText(lang, "retryDelay")}</Text>
      <TextInput style={styles.input} value={draft.overrides?.retryDelayMs == null ? "" : String(draft.overrides.retryDelayMs)} keyboardType="number-pad" onChangeText={(value) => {
        const overrides = { ...draft.overrides }
        if (!value.trim()) delete overrides.retryDelayMs
        else overrides.retryDelayMs = Math.round(Number(value))
        setDraft({ ...draft, overrides })
      }} placeholder={taskText(lang, "inherit")} placeholderTextColor={theme.muted} />
      <Text style={styles.label}>{taskText(lang, "jitter")}</Text>
      <TextInput style={styles.input} value={draft.jitterPct == null ? "" : String(draft.jitterPct)} keyboardType="number-pad" onChangeText={(value) => setDraft({ ...draft, jitterPct: value.trim() === "" ? null : Number(value) })} placeholderTextColor={theme.muted} />
      <View style={styles.row}>
        <Pressable style={styles.primary} onPress={() => void run(async () => {
          const result = await session!.saveTask(draft)
          if (result.ok) onSaved(result.task?.id)
          return result
        })}><Text style={styles.primaryText}>{lang === "es" ? "Guardar" : "Save"}</Text></Pressable>
        <Pressable style={styles.secondary} onPress={onCancel}><Text style={styles.secondaryText}>{lang === "es" ? "Cancelar" : "Cancel"}</Text></Pressable>
      </View>
    </View>
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
  const account = asList<PhoneSnapshot["accounts"][number]>(snap?.accounts)[0]
  const profile = asList<PhoneSnapshot["profiles"][number]>(snap?.profiles)[0]
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
        <Text key={row.store} style={styles.p}>{row.storeName} · {row.success} won · {row.failure} failed · ${Number(row.spend ?? 0).toFixed(2)}</Text>
      ))}
      {(stats?.recent ?? []).map((row) => (
        <Text key={`${row.at}-${row.sku}`} style={styles.log}>{row.outcome} · {row.storeName} · {row.sku}{row.price == null ? "" : ` · $${Number(row.price).toFixed(2)}`}</Text>
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
      {asList<PhoneTask["logs"][number]>(task.logs).map((line, index) => (
        <Text key={`${line.ts}-${index}`} style={[styles.log, stockOfLine(line.message) ? { color: stockColor(stockOfLine(line.message)) } : null]}>{line.message}</Text>
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
        store: (() => { const id = asList<{ id?: string }>(snap?.stores)[0]?.id; return id && isStoreId(id) ? id : "target" })(),
        sku: "",
        keywords: "",
        taskId: null,
        profileId: asList<{ id?: string }>(snap?.profiles)[0]?.id ?? "",
        accountId: asList<{ id?: string }>(snap?.accounts)[0]?.id ?? "",
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
        profileId: asList<{ id?: string }>(snap?.profiles)[0]?.id ?? "",
        accountId: asList<{ id?: string; store?: string }>(snap?.accounts).find((account) => account.store === "target")?.id ?? "",
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

/** Neon green and red mean stock only. Blocked is amber; idle and watching stay neutral. */
function stockColor(stock: StockState): string | undefined {
  if (stock === "in") return "#39ff88"
  if (stock === "out") return "#ff4d6d"
  return undefined
}

function statusColor(status: string): string {
  if (status === "success" || status === "tested") return "#c4b5fd"
  if (status === "failed") return "#f472b6"
  if (status === "adding_to_cart" || status === "checking_out") return "#22d3ee"
  if (status === "paused" || status === "challenge") return "#fbbf24"
  return "#a3a8c9"
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
    pad: { padding: 16, paddingTop: 48, paddingBottom: 24, gap: 10 },
    brand: { color: c.accent, letterSpacing: 2, fontSize: 12, fontWeight: "700" },
    h1: { color: c.text, fontSize: 22, fontWeight: "700" },
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
    photo: { width: 36, height: 36, borderRadius: 8 },
    tabBar: { flexDirection: "row", borderTopWidth: 1, borderTopColor: c.line, backgroundColor: c.sidebar, paddingBottom: 18, paddingTop: 6 },
    tab: { flex: 1, alignItems: "center", paddingVertical: 6 },
    tabText: { color: c.muted, fontSize: 11, fontWeight: "700" },
    tabOn: { color: c.accent }
  })
}
