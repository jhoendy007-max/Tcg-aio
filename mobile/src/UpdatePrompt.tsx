import { useEffect, useState } from "react"
import { AppState, Modal, Pressable, Text, View } from "react-native"
import { RELEASE_OWNER, RELEASE_REPO } from "../../src/shared/version"
import { decidePhoneUpdate, emptyPhoneUpdate, phoneDownloadProgress, phoneUpdateFailed, phoneUpdateReady, readPhoneReleases, startPhoneCheck, startPhoneDownload, type PhoneUpdateState } from "../../src/shared/phone-update"
import { promptVisible, runningTaskWarning, shortenNotes, tasksAreRunning, updateInstallLabel } from "../../src/shared/update-prompt"
import { downloadApk, openApkInstaller } from "./apk-install"
import { PHONE_VERSION } from "./version"
import { colors } from "./theme"

export function PhoneUpdatePrompt({ tasks }: { tasks: { status?: string }[] }) {
  const [state, setState] = useState<PhoneUpdateState>(() => emptyPhoneUpdate(PHONE_VERSION))
  const [later, setLater] = useState(false)
  const [waitIdle, setWaitIdle] = useState(false)
  const running = tasksAreRunning(tasks)
  const visible = promptVisible(state.phase, later)

  useEffect(() => {
    void check(setState, setLater, setWaitIdle)
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void check(setState, setLater, setWaitIdle)
    })
    return () => sub.remove()
  }, [])

  useEffect(() => {
    if (!waitIdle || running || !visible) return
    if (state.phase !== "available" && state.phase !== "ready") return
    setWaitIdle(false)
    void install(state, setState)
  }, [waitIdle, running, visible, state])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setLater(true)}>
      <View style={styles.scrim}>
        <View style={styles.card}>
          <Text style={styles.title}>Update {state.version}</Text>
          <Text style={styles.notes}>{shortenNotes(state.notes)}</Text>
          {running ? <Text style={styles.warn}>{runningTaskWarning()}</Text> : null}
          {waitIdle ? <Text style={styles.notes}>The update will install when the running tasks finish.</Text> : null}
          {state.phase === "error" ? <Text style={styles.warn}>{state.error}</Text> : null}
          <Pressable style={styles.primary} disabled={state.phase === "downloading"} onPress={() => void install(state, setState)}>
            <Text style={styles.primaryText}>{updateInstallLabel(state.phase, state.percent)}</Text>
          </Pressable>
          {running ? <Pressable style={styles.secondary} disabled={waitIdle} onPress={() => setWaitIdle(true)}><Text style={styles.secondaryText}>When tasks finish</Text></Pressable> : null}
          <Pressable style={styles.secondary} onPress={() => { setLater(true); setWaitIdle(false) }}><Text style={styles.secondaryText}>Later</Text></Pressable>
        </View>
      </View>
    </Modal>
  )
}

async function check(
  setState: (value: PhoneUpdateState) => void,
  setLater: (value: boolean) => void,
  setWaitIdle: (value: boolean) => void
): Promise<void> {
  setLater(false)
  setWaitIdle(false)
  const checking = startPhoneCheck(emptyPhoneUpdate(PHONE_VERSION))
  setState(checking)
  try {
    const response = await fetch(`https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases?per_page=10`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "TCGAIO-Phone" }
    })
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`)
    setState(decidePhoneUpdate(checking, readPhoneReleases(await response.text()), PHONE_VERSION))
  } catch (err) {
    setState(phoneUpdateFailed(checking, err instanceof Error ? err.message : "The update check failed."))
  }
}

async function install(state: PhoneUpdateState, setState: (value: PhoneUpdateState | ((current: PhoneUpdateState) => PhoneUpdateState)) => void): Promise<void> {
  const next = startPhoneDownload(state.phase === "ready" ? { ...state, phase: "available" } : state)
  if (state.phase !== "ready") setState(next)
  if (!state.apkUrl) return
  try {
    const uri = await downloadApk(state.apkUrl, (percent) => setState((current) => phoneDownloadProgress(current, percent)))
    setState((current) => phoneUpdateReady(current))
    await openApkInstaller(uri)
  } catch (err) {
    setState((current) => phoneUpdateFailed(current, err instanceof Error ? err.message : "The APK could not be installed."))
  }
}

const styles = {
  scrim: { flex: 1, backgroundColor: "rgba(8, 9, 12, 0.72)", justifyContent: "center" as const, padding: 24 },
  card: { backgroundColor: colors.card, borderRadius: 16, padding: 22, gap: 10 },
  title: { color: colors.text, fontSize: 20, fontWeight: "700" as const },
  notes: { color: colors.muted, fontSize: 14 },
  warn: { color: colors.warn, fontSize: 14 },
  primary: { backgroundColor: colors.accent, borderRadius: 10, padding: 12, alignItems: "center" as const },
  primaryText: { color: colors.accentInk, fontWeight: "700" as const },
  secondary: { borderRadius: 10, padding: 12, alignItems: "center" as const },
  secondaryText: { color: colors.text, fontWeight: "600" as const }
}
