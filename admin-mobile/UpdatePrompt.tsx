import { useCallback, useEffect, useRef, useState } from "react"
import { AppState, Modal, Pressable, Text, View } from "react-native"
import Constants from "expo-constants"
import * as FileSystem from "expo-file-system/legacy"
import * as IntentLauncher from "expo-intent-launcher"
import { apkInstaller } from "./modules/zzz-apk-installer"
import {
  ADMIN_PACKAGE,
  APK_INSTALL_FLAGS,
  adminDownloadTarget,
  adminUpdateDecision,
  apkMagicOk,
  downloadFailure,
  installedVersionCode,
  installerResultError,
  plainUpdateError,
  preserveUpdatePhase
} from "../src/shared/admin-update"
import { shortenNotes } from "../src/shared/update-prompt"

type Phase = "checking" | "current" | "missing" | "available" | "downloading" | "installing" | "error"

export function AdminUpdatePrompt({ base, token, onAuthError }: { base: string; token: string; onAuthError: (message: string) => void }) {
  const localCode = installedVersionCode(Constants.nativeBuildVersion, Constants.expoConfig?.android?.versionCode)
  const [version, setVersion] = useState("")
  const [notes, setNotes] = useState("")
  const [phase, setPhase] = useState<Phase>("checking")
  const [percent, setPercent] = useState(0)
  const [message, setMessage] = useState("Checking")
  const [later, setLater] = useState(false)
  const phaseRef = useRef<Phase>("checking")
  const onAuthErrorRef = useRef(onAuthError)
  onAuthErrorRef.current = onAuthError
  const showModal = !later && (phase === "available" || phase === "downloading" || phase === "installing" || (phase === "error" && Boolean(version)))

  function move(next: Phase) {
    phaseRef.current = next
    setPhase(next)
  }

  const check = useCallback(async () => {
    if (preserveUpdatePhase(phaseRef.current)) return
    setLater(false)
    move("checking")
    setMessage("Checking")
    try {
      // Signed out: the public endpoint reports the version; installing still needs a sign-in.
      const response = token
        ? await fetch(`${base.replace(/\/$/, "")}/v1/admin/app`, { headers: { authorization: `Bearer ${token}` } })
        : await fetch(`${base.replace(/\/$/, "")}/v1/admin/app/latest`)
      const info = await response.json() as { available?: boolean; version?: string; versionCode?: number; notes?: string; error?: string }
      if (preserveUpdatePhase(phaseRef.current)) return
      if (response.status === 401) {
        onAuthErrorRef.current(info.error || "Sign in to the admin desk again.")
        return
      }
      if (!response.ok) throw new Error(info.error || `The update check stopped (HTTP ${response.status}).`)
      const decision = adminUpdateDecision(localCode, info)
      setNotes(typeof info.notes === "string" ? info.notes : "")
      if (decision.phase === "available") {
        setVersion(decision.version)
        move("available")
        setMessage(`Admin ${decision.version} is ready to install.`)
        return
      }
      setVersion("")
      move(decision.phase)
      setMessage(decision.message)
    } catch (err) {
      if (preserveUpdatePhase(phaseRef.current)) return
      move("error")
      setMessage(plainUpdateError(err))
    }
  }, [base, token, localCode])

  useEffect(() => {
    void check()
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void check()
    })
    return () => sub.remove()
  }, [check])

  async function install() {
    if (phaseRef.current === "downloading") return
    if (!token) {
      onAuthErrorRef.current("Sign in to download the update.")
      return
    }
    setMessage("")
    move("downloading")
    setPercent(0)
    try {
      const url = await downloadTarget(base, token)
      const dest = `${FileSystem.cacheDirectory ?? ""}tcgaio-admin-update.apk`
      await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined)
      const task = FileSystem.createDownloadResumable(url, dest, { headers: { authorization: `Bearer ${token}` } }, (progress) => {
        const total = progress.totalBytesExpectedToWrite
        setPercent(total > 0 ? Math.round((progress.totalBytesWritten / total) * 100) : 0)
      })
      const result = await task.downloadAsync()
      if ((phaseRef.current as Phase) !== "downloading") return
      if (!result?.uri) throw new Error("The update download did not finish.")
      const failure = await readDownload(result.uri, result.status)
      if (failure) {
        await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => undefined)
        if (failure === "Sign in to the admin desk again.") {
          onAuthErrorRef.current(failure)
          return
        }
        throw new Error(failure)
      }
      move("installing")
      setPercent(100)
      setMessage("Confirm the install prompt. If you do not see it, allow this app to install unknown apps.")
      if (apkInstaller) {
        // 0.2.37: PackageInstaller session. Android shows its own confirm sheet; on success the app restarts updated.
        if (!apkInstaller.canRequestInstalls()) {
          move("error")
          setMessage("One-time step: tap Allow installs, turn on \"Allow from this source\", then tap Install again.")
          return
        }
        const done = await apkInstaller.install(result.uri)
        move("available")
        setMessage(done === "cancelled" ? "Install cancelled. Tap Install to try again." : "Installed. Reopen Zzz AIO Admin if it did not restart.")
        return
      }
      const content = await FileSystem.getContentUriAsync(result.uri)
      const opened = IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
        data: content,
        flags: APK_INSTALL_FLAGS,
        type: "application/vnd.android.package-archive",
        category: "android.intent.category.DEFAULT"
      }).then(
        (value) => ({ kind: "result" as const, code: Number(value.resultCode ?? 0) }),
        (err: unknown) => ({ kind: "error" as const, err })
      )
      const outcome = await Promise.race([
        opened,
        new Promise<{ kind: "waiting" }>((resolve) => setTimeout(() => resolve({ kind: "waiting" }), 1500))
      ])
      if (outcome.kind === "error") throw outcome.err
      if (outcome.kind === "result") {
        const problem = installerResultError(outcome.code)
        if (problem) throw new Error(problem)
        move("available")
        setMessage("Confirm the install if Android is still showing it.")
        return
      }
      void opened.then((late) => {
        if (phaseRef.current !== "installing") return
        if (late.kind === "error") {
          move("error")
          setMessage(plainUpdateError(late.err))
          return
        }
        const problem = installerResultError(late.code)
        if (problem) {
          move("error")
          setMessage(problem)
          return
        }
        move("available")
        setMessage("Confirm the install if Android is still showing it.")
      })
    } catch (err) {
      const text = plainUpdateError(err)
      if (text === "Sign in to the admin desk again.") {
        onAuthErrorRef.current(text)
        return
      }
      move("error")
      setMessage(text)
    }
  }

  async function allowInstalls() {
    try {
      await IntentLauncher.startActivityAsync("android.settings.MANAGE_UNKNOWN_APP_SOURCES", { data: `package:${ADMIN_PACKAGE}` })
    } catch (err) {
      move("error")
      setMessage(plainUpdateError(err))
    }
  }

  function panel(includeLater: boolean) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>{version ? `Update ${version}` : "Updates"}</Text>
        {phase === "checking" ? <Text style={styles.notes}>Checking</Text> : null}
        {phase === "current" ? <Text style={styles.notes}>Up to date</Text> : null}
        {phase === "missing" ? <Text style={styles.notes}>{message}</Text> : null}
        {phase === "available" || phase === "installing" ? <Text style={styles.notes}>{shortenNotes(notes || message)}</Text> : null}
        {phase === "downloading" ? <Text style={styles.notes}>Downloading {percent}%</Text> : null}
        {phase === "error" ? <Text style={styles.warn}>{message}</Text> : null}
        {phase === "installing" ? <Text style={styles.warn}>{message}</Text> : null}
        {phase === "available" || phase === "error" || phase === "installing" ? (
          <Pressable style={styles.primary} onPress={() => void install()}>
            <Text style={styles.primaryText}>{phase === "error" || phase === "installing" ? "Retry" : "Install"}</Text>
          </Pressable>
        ) : null}
        {phase === "error" || phase === "installing" ? (
          <Pressable style={styles.secondary} onPress={() => void allowInstalls()}><Text style={styles.secondaryText}>Allow installs</Text></Pressable>
        ) : null}
        {phase === "current" || phase === "missing" || phase === "checking" ? (
          <Pressable style={styles.secondary} disabled={phase === "checking"} onPress={() => void check()}><Text style={styles.secondaryText}>{phase === "checking" ? "Checking" : "Check for updates"}</Text></Pressable>
        ) : null}
        {includeLater ? <Pressable style={styles.secondary} onPress={() => setLater(true)}><Text style={styles.secondaryText}>Later</Text></Pressable> : null}
      </View>
    )
  }

  return (
    <>
      {panel(false)}
      <Modal visible={showModal} transparent animationType="fade" onRequestClose={() => setLater(true)}>
        <View style={styles.scrim}>{panel(true)}</View>
      </Modal>
    </>
  )
}

async function downloadTarget(base: string, token: string): Promise<string> {
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/v1/admin/app/ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}"
    })
    const body = response.ok ? await response.json().catch(() => ({})) as { ticket?: string } : {}
    const decision = adminDownloadTarget(base, response.status, body.ticket)
    if (decision.kind === "auth") throw new Error("Sign in to the admin desk again.")
    return decision.url
  } catch (err) {
    if (plainUpdateError(err) === "Sign in to the admin desk again.") throw err
    return `${base.replace(/\/$/, "")}/v1/admin/app/download`
  }
}

async function readDownload(uri: string, status: number): Promise<string | null> {
  if (status === 200) {
    const head = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64, position: 0, length: 8 })
    return downloadFailure(status, "", apkMagicOk(head))
  }
  const body = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8, position: 0, length: 400 }).catch(() => "")
  return downloadFailure(status, body, false)
}

const styles = {
  scrim: { flex: 1, backgroundColor: "rgba(8, 9, 12, 0.72)", justifyContent: "center" as const, padding: 24 },
  card: { backgroundColor: "#171b22", borderRadius: 16, padding: 22, gap: 10 },
  title: { color: "#f2f5f8", fontSize: 20, fontWeight: "700" as const },
  notes: { color: "#93a0b5", fontSize: 14 },
  warn: { color: "#e0a045", fontSize: 14 },
  primary: { backgroundColor: "#e0b15a", borderRadius: 10, padding: 12, alignItems: "center" as const },
  primaryText: { color: "#1c1508", fontWeight: "700" as const },
  secondary: { borderRadius: 10, padding: 12, alignItems: "center" as const },
  secondaryText: { color: "#f2f5f8", fontWeight: "600" as const }
}
