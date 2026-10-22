import { useEffect, useState } from "react"
import { AppState, Modal, Pressable, Text, View } from "react-native"
import * as FileSystem from "expo-file-system/legacy"
import * as IntentLauncher from "expo-intent-launcher"
import { promptVisible, shortenNotes, updateInstallLabel } from "../src/shared/update-prompt"

export function AdminUpdatePrompt({ base, token, versionCode }: { base: string; token: string; versionCode: number }) {
  const [version, setVersion] = useState("")
  const [notes, setNotes] = useState("")
  const [remoteCode, setRemoteCode] = useState(0)
  const [phase, setPhase] = useState<"idle" | "downloading" | "ready" | "error">("idle")
  const [percent, setPercent] = useState<number | null>(null)
  const [error, setError] = useState("")
  const [later, setLater] = useState(false)
  const visible = remoteCode > versionCode && promptVisible(phase === "idle" ? "available" : phase, later)

  useEffect(() => {
    void check(base, token, setVersion, setNotes, setRemoteCode, setLater)
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void check(base, token, setVersion, setNotes, setRemoteCode, setLater)
    })
    return () => sub.remove()
  }, [base, token])

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setLater(true)}>
      <View style={styles.scrim}>
        <View style={styles.card}>
          <Text style={styles.title}>Update {version}</Text>
          <Text style={styles.notes}>{shortenNotes(notes)}</Text>
          {error ? <Text style={styles.warn}>{error}</Text> : null}
          <Pressable style={styles.primary} disabled={phase === "downloading"} onPress={() => void install(base, token, setPhase, setPercent, setError)}>
            <Text style={styles.primaryText}>{updateInstallLabel(phase === "idle" ? "available" : phase, percent)}</Text>
          </Pressable>
          <Pressable style={styles.secondary} onPress={() => setLater(true)}><Text style={styles.secondaryText}>Later</Text></Pressable>
        </View>
      </View>
    </Modal>
  )
}

async function check(
  base: string,
  token: string,
  setVersion: (value: string) => void,
  setNotes: (value: string) => void,
  setRemoteCode: (value: number) => void,
  setLater: (value: boolean) => void
): Promise<void> {
  setLater(false)
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/v1/admin/app`, { headers: { authorization: `Bearer ${token}` } })
    const info = await response.json() as { available?: boolean; version?: string; versionCode?: number; notes?: string }
    if (!response.ok) return
    setVersion(String(info.version ?? ""))
    setNotes(typeof info.notes === "string" ? info.notes : "")
    setRemoteCode(info.available === true ? Number(info.versionCode ?? 0) : 0)
  } catch {
    setRemoteCode(0)
  }
}

async function install(
  base: string,
  token: string,
  setPhase: (value: "idle" | "downloading" | "ready" | "error") => void,
  setPercent: (value: number | null) => void,
  setError: (value: string) => void
): Promise<void> {
  setError("")
  setPhase("downloading")
  setPercent(0)
  try {
    const dest = `${FileSystem.cacheDirectory ?? ""}tcgaio-admin-update.apk`
    await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined)
    const task = FileSystem.createDownloadResumable(`${base.replace(/\/$/, "")}/v1/admin/app/download`, dest, { headers: { authorization: `Bearer ${token}` } }, (progress) => {
      const total = progress.totalBytesExpectedToWrite
      setPercent(total > 0 ? Math.round((progress.totalBytesWritten / total) * 100) : 0)
    })
    const result = await task.downloadAsync()
    if (!result?.uri) throw new Error("The update download did not finish.")
    setPhase("ready")
    setPercent(100)
    const content = await FileSystem.getContentUriAsync(result.uri)
    await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
      data: content,
      flags: 1,
      type: "application/vnd.android.package-archive"
    })
  } catch (err) {
    setPhase("error")
    setError(err instanceof Error ? err.message : "Could not install the update.")
  }
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
