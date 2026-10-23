import { useEffect, useState } from "react"
import { LogsToggle } from "./LogsToggle"
import { stockOfLine } from "../../src/shared/stock"
import { Alert, Pressable, Text, TextInput, View } from "react-native"
import type { PhoneSession } from "../../src/phone/client"
import type { PhoneSnapshot } from "../../src/phone/protocol"
import type { PhoneAccountDraft, PhoneClientDraft, PhoneProfileDraft, PhoneProxyDraft, PhoneQuickDraft } from "../../src/phone/desk"
import { asList } from "../../src/phone/task-draft"
import { useTheme } from "./theme-context"

type Run = (action: () => Promise<{ ok: boolean; error?: string; csv?: string; created?: number }>) => Promise<unknown>

const blankAddress = { firstName: "", lastName: "", line1: "", line2: "", city: "", state: "", zip: "", country: "US" as const }

export function DeskPanel({ snap, session, run, focus = "all" }: { snap: PhoneSnapshot | null; session: PhoneSession | null; run: Run; focus?: "all" | "people" | "clients" }) {
  const { styles, colors } = useTheme()
  const choices = focus === "clients" ? (["clients"] as const) : focus === "people" ? (["profiles", "accounts", "proxies"] as const) : (["quick", "profiles", "accounts", "proxies", "clients"] as const)
  const [section, setSection] = useState<(typeof choices)[number]>(choices[0])
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.choices}>
        {choices.map((id) => (
          <Pressable key={id} style={[styles.choice, section === id && styles.choiceOn]} onPress={() => setSection(id)}>
            <Text style={styles.choiceText}>{id === "quick" ? "Quick setup" : id[0].toUpperCase() + id.slice(1)}</Text>
          </Pressable>
        ))}
      </View>
      {section === "quick" ? <QuickForm snap={snap} session={session} run={run} /> : null}
      {section === "profiles" ? <ProfileForm snap={snap} session={session} run={run} /> : null}
      {section === "accounts" ? <AccountForm snap={snap} session={session} run={run} /> : null}
      {section === "proxies" ? <ProxyForm snap={snap} session={session} run={run} /> : null}
      {section === "clients" ? <ClientForm snap={snap} session={session} run={run} /> : null}
      <Text style={{ color: colors.muted, fontSize: 12 }}>Cards stay on the PC. The phone only sees the last four digits. Checkouts still run in the desktop browser.</Text>
    </View>
  )
}

export function LogsPanel({ snap }: { snap: PhoneSnapshot | null }) {
  const { styles } = useTheme()
  const lines = asList<NonNullable<PhoneSnapshot["tasks"]>[number]>(snap?.tasks).flatMap((task) => asList<NonNullable<typeof task.logs>[number]>(task.logs).slice(-3).map((line) => ({ id: `${task.id}-${line.ts}-${line.message}`, text: `${task.storeName} · ${task.sku || task.keywords || "task"} · ${line.message}` }))).slice(-30)
  const history = snap?.analytics?.recent ?? []
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.card}>
        <Text style={styles.h2}>Activity</Text>
        {lines.length === 0 ? <Text style={styles.p}>Task logs appear here while the PC is running them.</Text> : (
          <LogsToggle count={lines.length}>
            {lines.map((line) => <Text key={line.id} style={[styles.log, stockOfLine(line.text) ? { color: stockOfLine(line.text) === "in" ? "#39ff88" : "#ff4d6d" } : null]}>{line.text}</Text>)}
          </LogsToggle>
        )}
      </View>
      <View style={styles.card}>
        <Text style={styles.h2}>Success and declines</Text>
        {history.length === 0 ? <Text style={styles.p}>No checkout history yet.</Text> : history.map((row, index) => (
          <Text key={`${row.at}-${index}`} style={styles.p}>{row.outcome} · {row.storeName} · {row.sku}{row.price != null ? ` · $${row.price.toFixed(2)}` : ""}</Text>
        ))}
      </View>
    </View>
  )
}

export function PhoneSettingsForm({ snap, session, run }: { snap: PhoneSnapshot | null; session: PhoneSession | null; run: Run }) {
  const { styles, colors } = useTheme()
  const desk = snap?.desk
  const [limits, setLimits] = useState(desk?.addressOrderLimits ?? "")
  const [webhook, setWebhook] = useState("")
  const [name, setName] = useState(desk?.appName ?? "Zzz AIO")
  useEffect(() => {
    if (!desk) return
    setLimits(desk.addressOrderLimits ?? "")
    setName(desk.appName ?? "Zzz AIO")
  }, [desk?.addressOrderLimits, desk?.appName])
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>PC settings</Text>
      <Text style={styles.p}>Address order limit, webhook, and warm-up are saved on the PC. A webhook already saved is not sent back to the phone.</Text>
      <Text style={styles.label}>Address order limits</Text>
      <TextInput style={styles.input} value={limits} onChangeText={setLimits} placeholder="target:3" placeholderTextColor={colors.muted} autoCapitalize="none" />
      <Text style={styles.label}>Discord webhook {desk?.hasWebhook ? "(one is saved)" : ""}</Text>
      <TextInput style={styles.input} value={webhook} onChangeText={setWebhook} placeholder="https://discord.com/api/webhooks/…" placeholderTextColor={colors.muted} autoCapitalize="none" />
      <Text style={styles.label}>App name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholderTextColor={colors.muted} />
      <View style={styles.row}>
        <Pressable style={styles.primary} onPress={() => void run(() => session!.saveDeskSettings({
          addressOrderLimits: limits,
          appName: name,
          webhookAction: webhook.trim() ? "replace" : "keep",
          webhook
        }))}><Text style={styles.primaryText}>Save settings</Text></Pressable>
        <Pressable style={styles.secondary} onPress={() => void run(() => session!.saveDeskSettings({ testMode: !(desk?.testMode === true) }))}><Text style={styles.secondaryText}>{desk?.testMode ? "Test mode on" : "Test mode off"}</Text></Pressable>
        <Pressable style={styles.secondary} onPress={() => void run(() => session!.saveDeskSettings({ sessionWarmup: !(desk?.sessionWarmup === true) }))}><Text style={styles.secondaryText}>{desk?.sessionWarmup ? "Warm-up on" : "Warm-up off"}</Text></Pressable>
      </View>
    </View>
  )
}

function QuickForm({ snap, session, run }: { snap: PhoneSnapshot | null; session: PhoneSession | null; run: Run }) {
  const { styles, colors } = useTheme()
  const [sku, setSku] = useState("")
  const [profileId, setProfileId] = useState(asList<{ id?: string }>(snap?.profiles)[0]?.id ?? "")
  const [accountId, setAccountId] = useState(asList<{ id?: string }>(snap?.accounts)[0]?.id ?? "")
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Quick setup</Text>
      <Text style={styles.p}>Creates a monitor and a checkout that starts when that monitor sees stock. Both run on the PC.</Text>
      <TextInput style={styles.input} value={sku} onChangeText={setSku} placeholder="SKU or URL" placeholderTextColor={colors.muted} autoCapitalize="none" />
      <ChoiceRow label="Profile" options={(snap?.profiles ?? []).map((profile) => ({ id: profile.id, label: `${profile.name} · ${profile.last4}` }))} value={profileId} onChange={setProfileId} />
      <ChoiceRow label="Account" options={(snap?.accounts ?? []).map((account) => ({ id: account.id, label: account.label }))} value={accountId} onChange={setAccountId} />
      <Pressable style={styles.primary} onPress={() => void run(() => {
        const setup: PhoneQuickDraft = { store: asList<{ id?: string; store?: PhoneQuickDraft["store"] }>(snap?.accounts).find((account) => account.id === accountId)?.store ?? "target", sku, keywords: "", profileId, accountId, proxyGroupId: null, quantity: 1, testMode: true, confirmPurchase: false }
        return session!.quickSetup(setup)
      })}><Text style={styles.primaryText}>Create monitor and checkout</Text></Pressable>
    </View>
  )
}

function ProfileForm({ snap, session, run }: { snap: PhoneSnapshot | null; session: PhoneSession | null; run: Run }) {
  const { styles, colors } = useTheme()
  const [id, setId] = useState<string | undefined>()
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [card, setCard] = useState("")
  const [expMonth, setExpMonth] = useState("")
  const [expYear, setExpYear] = useState("")
  const [cvv, setCvv] = useState("")
  const [line1, setLine1] = useState("")
  const [city, setCity] = useState("")
  const [state, setState] = useState("")
  const [zip, setZip] = useState("")
  const [phone, setPhone] = useState("")
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Profiles</Text>
      {(snap?.profiles ?? []).map((profile) => (
        <View key={profile.id} style={styles.row}>
          <Text style={styles.p}>{profile.name} · ····{profile.last4} · {profile.city}</Text>
          <Pressable onPress={() => {
            setId(profile.id)
            setName(profile.name)
            setEmail(profile.email)
            setPhone(profile.phone)
            setLine1(profile.shipping?.line1 ?? "")
            setCity(profile.shipping?.city ?? "")
            setState(profile.shipping?.state ?? "")
            setZip(profile.shipping?.zip ?? "")
            setExpMonth(profile.expMonth)
            setExpYear(profile.expYear)
            setCard("")
            setCvv("")
          }}><Text style={styles.link}>Edit</Text></Pressable>
          <Pressable onPress={() => confirmDelete(() => void run(() => session!.deleteProfile(profile.id)))}><Text style={styles.link}>Delete</Text></Pressable>
        </View>
      ))}
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Name" placeholderTextColor={colors.muted} />
      <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={colors.muted} autoCapitalize="none" />
      <TextInput style={styles.input} value={phone} onChangeText={setPhone} placeholder="Phone" placeholderTextColor={colors.muted} keyboardType="phone-pad" />
      <TextInput style={styles.input} value={line1} onChangeText={setLine1} placeholder="Street" placeholderTextColor={colors.muted} />
      <TextInput style={styles.input} value={city} onChangeText={setCity} placeholder="City" placeholderTextColor={colors.muted} />
      <TextInput style={styles.input} value={state} onChangeText={setState} placeholder="State" placeholderTextColor={colors.muted} autoCapitalize="characters" />
      <TextInput style={styles.input} value={zip} onChangeText={setZip} placeholder="ZIP" placeholderTextColor={colors.muted} />
      <TextInput style={styles.input} value={card} onChangeText={setCard} placeholder="Card number (sent once, stored encrypted on the PC)" placeholderTextColor={colors.muted} keyboardType="number-pad" />
      <TextInput style={styles.input} value={expMonth} onChangeText={setExpMonth} placeholder="Exp month" placeholderTextColor={colors.muted} keyboardType="number-pad" />
      <TextInput style={styles.input} value={expYear} onChangeText={setExpYear} placeholder="Exp year" placeholderTextColor={colors.muted} keyboardType="number-pad" />
      <TextInput style={styles.input} value={cvv} onChangeText={setCvv} placeholder="CVV" placeholderTextColor={colors.muted} keyboardType="number-pad" secureTextEntry />
      <Pressable style={styles.primary} onPress={() => {
        const shipping = { ...blankAddress, firstName: name.split(" ")[0] ?? "", lastName: name.split(" ").slice(1).join(" "), line1, city, state, zip }
        const profile: PhoneProfileDraft = { id, name, email, phone, shipping, billing: shipping, cardName: name, cardNumber: card, expMonth, expYear, cvv, cardAction: card.trim() ? "replace" : "keep" }
        void run(async () => {
          const result = await session!.saveProfile(profile)
          if (result.ok) { setCard(""); setCvv("") }
          return result
        })
      }}><Text style={styles.primaryText}>Save profile on PC</Text></Pressable>
    </View>
  )
}

function AccountForm({ snap, session, run }: { snap: PhoneSnapshot | null; session: PhoneSession | null; run: Run }) {
  const { styles, colors } = useTheme()
  const [label, setLabel] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [store, setStore] = useState(asList<{ id?: string }>(snap?.stores)[0]?.id ?? "target")
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Accounts</Text>
      {(snap?.accounts ?? []).map((account) => (
        <View key={account.id} style={styles.row}>
          <Text style={styles.p}>{account.label} · {account.usernameMasked} · {account.sessionState ?? (account.hasSession ? "saved" : "missing")}</Text>
          <Pressable onPress={() => void run(() => session!.warmAccount(account.id))}><Text style={styles.link}>Warm</Text></Pressable>
          <Pressable onPress={() => void run(() => session!.openAccountLogin(account.id))}><Text style={styles.link}>Sign in on PC</Text></Pressable>
          <Pressable onPress={() => confirmDelete(() => void run(() => session!.deleteAccount(account.id)))}><Text style={styles.link}>Delete</Text></Pressable>
        </View>
      ))}
      <ChoiceRow label="Store" options={(snap?.stores ?? []).map((item) => ({ id: item.id, label: item.name }))} value={store} onChange={(id) => setStore(id as typeof store)} />
      <TextInput style={styles.input} value={label} onChangeText={setLabel} placeholder="Label" placeholderTextColor={colors.muted} />
      <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Account email" placeholderTextColor={colors.muted} autoCapitalize="none" />
      <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="Password (stored encrypted on the PC)" placeholderTextColor={colors.muted} secureTextEntry />
      <Pressable style={styles.primary} onPress={() => {
        const account: PhoneAccountDraft = { store: store as PhoneAccountDraft["store"], label, username: email, password, passwordAction: password ? "replace" : "keep", proxyGroupId: null }
        void run(async () => {
          const result = await session!.saveAccount(account)
          if (result.ok) setPassword("")
          return result
        })
      }}><Text style={styles.primaryText}>Save account on PC</Text></Pressable>
    </View>
  )
}

function ProxyForm({ snap, session, run }: { snap: PhoneSnapshot | null; session: PhoneSession | null; run: Run }) {
  const { styles, colors } = useTheme()
  const [name, setName] = useState("")
  const [text, setText] = useState("")
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Proxies</Text>
      <Text style={styles.p}>Existing proxy passwords stay on the PC. Pasting a list replaces that group.</Text>
      {(snap?.proxyGroups ?? []).map((group) => (
        <View key={group.id} style={styles.row}>
          <Text style={styles.p}>{group.name} · {group.count}</Text>
          <Pressable onPress={() => confirmDelete(() => void run(() => session!.deleteProxy(group.id)))}><Text style={styles.link}>Delete</Text></Pressable>
        </View>
      ))}
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Group name" placeholderTextColor={colors.muted} />
      <TextInput style={[styles.input, styles.area]} value={text} onChangeText={setText} placeholder={"host:port:user:pass"} placeholderTextColor={colors.muted} autoCapitalize="none" multiline />
      <Pressable style={styles.primary} onPress={() => {
        const proxy: PhoneProxyDraft = { name, text, network: "residential" }
        void run(async () => {
          const result = await session!.saveProxy(proxy)
          if (result.ok) setText("")
          return result
        })
      }}><Text style={styles.primaryText}>Save proxy group</Text></Pressable>
    </View>
  )
}

function ClientForm({ snap, session, run }: { snap: PhoneSnapshot | null; session: PhoneSession | null; run: Run }) {
  const { styles, colors } = useTheme()
  const [name, setName] = useState("")
  const [fee, setFee] = useState("0")
  const [csv, setCsv] = useState("")
  const clients = snap?.clients ?? []
  const ledger = snap?.ledger ?? []
  return (
    <View style={styles.card}>
      <Text style={styles.h2}>Clients and charge log</Text>
      {clients.map((client) => (
        <View key={client.id} style={styles.row}>
          <Text style={styles.p}>{client.name} · ${client.fee.toFixed(2)} / {client.feeBasis} · {client.status}</Text>
          {client.id !== "me" ? <Pressable onPress={() => confirmDelete(() => void run(() => session!.deleteClient(client.id)))}><Text style={styles.link}>Delete</Text></Pressable> : null}
        </View>
      ))}
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Client name" placeholderTextColor={colors.muted} />
      <TextInput style={styles.input} value={fee} onChangeText={setFee} placeholder="Fee" placeholderTextColor={colors.muted} keyboardType="decimal-pad" />
      <Pressable style={styles.primary} onPress={() => {
        const client: PhoneClientDraft = { name, contact: "", notes: "", feeBasis: "success", fee: Number(fee) || 0, status: "active", webhook: "" }
        void run(() => session!.saveClient(client))
      }}><Text style={styles.primaryText}>Save client</Text></Pressable>
      {ledger.map((row) => (
        <View key={row.id} style={styles.row}>
          <Text style={styles.p}>{row.clientName} · {row.sku} · fee ${row.fee.toFixed(2)} · {row.paid ? "paid" : "open"}</Text>
          <Pressable onPress={() => void run(() => session!.markLedger(row.clientId, [row.id], !row.paid))}><Text style={styles.link}>{row.paid ? "Unpaid" : "Paid"}</Text></Pressable>
        </View>
      ))}
      <Pressable style={styles.secondary} onPress={() => void run(async () => {
        const result = await session!.ledgerCsv("")
        if (result.csv) setCsv(result.csv)
        return result
      })}><Text style={styles.secondaryText}>Show charge log CSV</Text></Pressable>
      {csv ? <Text selectable style={styles.log}>{csv}</Text> : null}
    </View>
  )
}

function confirmDelete(onYes: () => void) {
  Alert.alert("Delete?", "This cannot be undone.", [
    { text: "Cancel", style: "cancel" },
    { text: "Delete", style: "destructive", onPress: onYes }
  ])
}

function ChoiceRow({ label, options, value, onChange }: { label: string; options: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  const { styles } = useTheme()
  return (
    <View>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.choices}>
        {options.map((option) => (
          <Pressable key={option.id} style={[styles.choice, value === option.id && styles.choiceOn]} onPress={() => onChange(option.id)}>
            <Text style={styles.choiceText}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}
