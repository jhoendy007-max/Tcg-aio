import { useState } from "react"
import { Pressable, Text, View } from "react-native"
import { RELEASE_OWNER, RELEASE_REPO } from "../../src/shared/version"
import { decidePhoneUpdate, emptyPhoneUpdate, phoneDownloadProgress, phoneUpdateFailed, phoneUpdateReady, phoneUpdateText, readPhoneReleases, startPhoneCheck, startPhoneDownload, type PhoneUpdateState } from "../../src/shared/phone-update"
import { downloadApk, openApkInstaller } from "./apk-install"
import { PHONE_VERSION } from "./version"
import { useTheme } from "./theme-context"

export function PhoneUpdateCard() {
  const { styles } = useTheme()
  const [state, setState] = useState<PhoneUpdateState>(() => emptyPhoneUpdate(PHONE_VERSION))
  const busy = state.phase === "checking" || state.phase === "downloading"

  async function check() {
    const checking = startPhoneCheck(state)
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

  async function download() {
    const next = startPhoneDownload(state)
    setState(next)
    if (next.phase !== "downloading" || !next.apkUrl) return
    try {
      const uri = await downloadApk(next.apkUrl, (percent) => setState((current) => phoneDownloadProgress(current, percent)))
      setState((current) => phoneUpdateReady(current))
      await openApkInstaller(uri)
    } catch (err) {
      setState((current) => phoneUpdateFailed(current, err instanceof Error ? err.message : "The APK could not be installed."))
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Updates</Text>
      <Text style={styles.p}>Checks public GitHub releases for {RELEASE_OWNER}/{RELEASE_REPO}, including prereleases. The APK installs over this app when it is signed with the same key.</Text>
      <Text style={styles.p}>{phoneUpdateText(state)}</Text>
      {state.notes && (state.phase === "available" || state.phase === "ready") ? <Text style={styles.log}>{state.notes.slice(0, 500)}</Text> : null}
      <View style={styles.row}>
        <Pressable style={styles.secondary} disabled={busy} onPress={() => void check()}><Text style={styles.secondaryText}>{state.phase === "checking" ? "Checking…" : "Check for updates"}</Text></Pressable>
        {state.phase === "available" || state.phase === "downloading" ? (
          <Pressable style={styles.primary} disabled={state.phase === "downloading"} onPress={() => void download()}><Text style={styles.primaryText}>{state.phase === "downloading" ? `Downloading ${Math.round(state.percent ?? 0)}%` : "Download"}</Text></Pressable>
        ) : null}
        {state.phase === "ready" ? <Pressable style={styles.primary} onPress={() => { if (state.apkUrl) void download() }}><Text style={styles.primaryText}>Install</Text></Pressable> : null}
      </View>
    </View>
  )
}
