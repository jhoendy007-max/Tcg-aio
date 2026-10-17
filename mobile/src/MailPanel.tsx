import { useMemo, useState } from "react"
import { Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native"
import type { PhoneSession } from "../../src/phone/client"
import type { PhoneMailDraft, PhoneSnapshot } from "../../src/phone/protocol"
import { detectMailbox, isMailHelpUrl, type MailLang, type MailProvider } from "../../src/shared/mail"
import { mailGuide, mailText, type MailTextKey } from "../../src/shared/mail-text"
import { palette } from "./theme"

export function MailPanel({ snap, session, onRun, onBack }: {
  snap: PhoneSnapshot | null
  session: PhoneSession | null
  onRun: (action: () => Promise<{ ok: boolean; error?: string }>) => Promise<unknown>
  onBack: () => void
}) {
  const lang: MailLang = snap?.language === "es" ? "es" : "en"
  const t = (key: MailTextKey) => mailText(lang, key)
  const theme = palette(snap?.brand)
  const styles = useMemo(() => panelStyles(theme), [theme])
  const [user, setUser] = useState("")
  const [provider, setProvider] = useState<MailProvider>("gmail")
  const [host, setHost] = useState("")
  const [port, setPort] = useState("993")
  const [secure, setSecure] = useState(true)
  const [password, setPassword] = useState("")
  const [orders, setOrders] = useState(true)
  const [codes, setCodes] = useState(true)
  const [alerts, setAlerts] = useState(false)
  const [guessed, setGuessed] = useState(false)

  function applyEmail(value: string) {
    setUser(value)
    const found = detectMailbox(value)
    setGuessed(Boolean(found?.guessed))
    if (!found) return
    setProvider(found.provider)
    setHost(found.host)
    setPort(String(found.port))
    setSecure(found.secure)
  }

  function draft(): PhoneMailDraft {
    return {
      user: user.trim(),
      provider,
      host,
      port: Number(port) || 993,
      secure,
      mailbox: "INBOX",
      password,
      orders,
      codes,
      alerts
    }
  }

  const guide = mailGuide(provider, lang)
  const rows = snap?.imap?.mailboxes ?? []

  return (
    <View>
      <Text style={styles.h2}>{t("phoneTitle")}</Text>
      <Text style={styles.p}>{t("phoneIntro")}</Text>
      <View style={styles.row}>
        <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.setLanguage("en"))}><Text style={styles.secondaryText}>English</Text></Pressable>
        <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.setLanguage("es"))}><Text style={styles.secondaryText}>Español</Text></Pressable>
        <Pressable style={styles.secondary} onPress={onBack}><Text style={styles.secondaryText}>{t("phoneBack")}</Text></Pressable>
      </View>
      {rows.map((row) => (
        <Text key={row.id} style={styles.p}>{row.enabled ? t("on") : t("off")} · {row.user} · {row.auth === "xoauth2" ? t("oauth") : t("password")}{row.lastError ? ` · ${row.lastError}` : ""}</Text>
      ))}
      <Text style={styles.label}>{t("email")}</Text>
      <TextInput value={user} onChangeText={applyEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" style={styles.input} placeholder="ada@gmail.com" placeholderTextColor={theme.muted} />
      {guessed ? <Text style={styles.p}>{t("guessed")}</Text> : null}
      <Text style={styles.p}>{t("detected")}: {provider} · {host || "—"}:{port} · {secure ? "SSL" : "STARTTLS"}</Text>
      {provider === "gmail" ? (
        <Pressable style={styles.primary} onPress={() => void onRun(() => session!.signInMail("gmail", user.trim()))}><Text style={styles.primaryText}>{t("signInGoogle")}</Text></Pressable>
      ) : null}
      {provider === "outlook" ? (
        <Pressable style={styles.primary} onPress={() => void onRun(() => session!.signInMail("outlook", user.trim()))}><Text style={styles.primaryText}>{t("signInMicrosoft")}</Text></Pressable>
      ) : null}
      <Text style={styles.h2}>{t("steps")}</Text>
      {guide.steps.map((step) => <Text key={step} style={styles.p}>{step}</Text>)}
      {guide.links.map((link) => (
        <Pressable key={link.href} style={styles.secondary} onPress={() => { if (isMailHelpUrl(link.href)) void Linking.openURL(link.href) }}>
          <Text style={styles.secondaryText}>{link.label}</Text>
        </Pressable>
      ))}
      <Text style={styles.label}>{t("appPassword")}</Text>
      <TextInput value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" style={styles.input} placeholderTextColor={theme.muted} />
      <View style={styles.switchRow}>
        <Text style={styles.p}>{t("codes")}</Text>
        <Switch value={codes} onValueChange={setCodes} />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.p}>{t("orders")}</Text>
        <Switch value={orders} onValueChange={setOrders} />
      </View>
      <View style={styles.switchRow}>
        <Text style={styles.p}>{t("alerts")}</Text>
        <Switch value={alerts} onValueChange={setAlerts} />
      </View>
      <Pressable style={styles.primary} onPress={() => void onRun(async () => {
        const result = await session!.saveMailbox(draft())
        if (result.ok) setPassword("")
        return result
      })}><Text style={styles.primaryText}>{t("phoneSave")}</Text></Pressable>
    </View>
  )
}

function panelStyles(c: ReturnType<typeof palette>) {
  return StyleSheet.create({
    h2: { color: c.text, fontSize: 18, fontWeight: "700", marginTop: 8 },
    p: { color: c.muted, fontSize: 14, lineHeight: 20 },
    label: { color: c.text, fontSize: 13, marginTop: 8 },
    input: { backgroundColor: c.card2, color: c.text, borderColor: c.line, borderWidth: 1, borderRadius: 8, padding: 10 },
    row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
    primary: { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, alignSelf: "flex-start" },
    primaryText: { color: c.accentInk, fontWeight: "700" },
    secondary: { borderColor: c.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, alignSelf: "flex-start" },
    secondaryText: { color: c.text }
  })
}
