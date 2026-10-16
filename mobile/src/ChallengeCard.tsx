import { useRef, useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { WebView, type WebViewMessageEvent } from "react-native-webview"
import type { PhoneSession } from "../../src/phone/client"
import type { PhoneChallenge } from "../../src/phone/protocol"
import { colors } from "./theme"

const HOSTS = new Set([
  "www.target.com",
  "www.walmart.com",
  "www.bestbuy.com",
  "www.pokemoncenter.com",
  "www.amazon.com",
  "www.crunchyroll.com"
])

export function ChallengeCard({
  challenge,
  now,
  session,
  onRun
}: {
  challenge: PhoneChallenge
  now: number
  session: PhoneSession | null
  onRun: (action: () => Promise<{ ok: boolean; error?: string }>) => Promise<unknown>
}) {
  const web = useRef<WebView<{ marker?: undefined }>>(null)
  const [open, setOpen] = useState(false)
  const url = safeUrl(challenge.url)
  const left = Math.max(0, Math.ceil((challenge.expiresAt - now) / 1000))
  const seed = url ? seedScript(challenge.cookie) : "true;"
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Solve the challenge</Text>
      <Text style={styles.p}>{challenge.storeName} · {challenge.sku} · {challenge.proxyLabel} · {left}s left</Text>
      <Text style={styles.p}>{challenge.reason}</Text>
      <Text style={styles.p}>A person solves this. TCGAIO does not send it to a solving service. Open on PC uses the task proxy and saves every cookie, including ones JavaScript cannot see. Solving on this phone uses the phone network and only sends cookies JavaScript can see.</Text>
      <View style={styles.row}>
        <Pressable style={styles.primary} onPress={() => void onRun(() => session!.openChallenge())}><Text style={styles.primaryText}>Open on PC</Text></Pressable>
        <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.completeChallenge())}><Text style={styles.secondaryText}>I solved it on PC</Text></Pressable>
        <Pressable style={styles.secondary} onPress={() => setOpen(true)}><Text style={styles.secondaryText}>Open on this phone</Text></Pressable>
        <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.dismissChallenge())}><Text style={styles.secondaryText}>Dismiss</Text></Pressable>
      </View>
      {open && url ? (
        <View>
          <WebView<{ marker?: undefined }>
            ref={web}
            source={{ uri: url }}
            style={styles.web}
            originWhitelist={["https://*"]}
            setSupportMultipleWindows={false}
            injectedJavaScriptBeforeContentLoaded={seed}
            onMessage={(event: WebViewMessageEvent) => {
              const cookie = event.nativeEvent.data
              if (!cookie || cookie.length > 8192) return
              void onRun(() => session!.submitChallenge(cookie))
            }}
          />
          <Pressable style={styles.secondary} onPress={() => {
            web.current?.injectJavaScript("window.ReactNativeWebView.postMessage(document.cookie || ''); true;")
          }}><Text style={styles.secondaryText}>Send phone cookies</Text></Pressable>
        </View>
      ) : null}
      {open && !url ? <Text style={styles.p}>This challenge page is not a store page, so it stays on the PC.</Text> : null}
    </View>
  )
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || !HOSTS.has(url.hostname)) return null
    return url.toString()
  } catch {
    return null
  }
}

function seedScript(cookie: string): string {
  return `(() => { const raw = ${JSON.stringify(cookie)}; for (const part of raw.split(";")) { const item = part.trim(); if (item) document.cookie = item + "; path=/"; } })(); true;`
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#3d3118", borderRadius: 10, padding: 14, gap: 8 },
  h2: { color: colors.text, fontSize: 16, fontWeight: "700" },
  p: { color: "#ffe1a8", fontSize: 14 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  primary: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  primaryText: { color: colors.accentInk, fontWeight: "700" },
  secondary: { borderColor: "#6d5a32", borderWidth: 1, borderRadius: 8, paddingVertical: 10, paddingHorizontal: 14 },
  secondaryText: { color: colors.text },
  web: { height: 420, marginTop: 8, backgroundColor: "#fff" }
})
