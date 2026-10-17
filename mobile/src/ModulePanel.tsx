import { useMemo, useState } from "react"
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native"
import type { PhoneSession } from "../../src/phone/client"
import type { PhoneSnapshot } from "../../src/phone/protocol"
import type { MailLang } from "../../src/shared/mail"
import {
  exportModulePreset,
  moduleText,
  recommendedModule,
  resolveModule,
  sourceLabel,
  type ModuleField,
  type ModuleTextKey
} from "../../src/shared/module-settings"
import { STORE_CATALOG } from "../../src/shared/stores"
import type { ModuleRecord, StoreId } from "../../src/shared/types"
import { palette } from "./theme"

export function ModulePanel({ snap, session, onRun, onBack }: {
  snap: PhoneSnapshot | null
  session: PhoneSession | null
  onRun: (action: () => Promise<{ ok: boolean; error?: string }>) => Promise<unknown>
  onBack: () => void
}) {
  const lang: MailLang = snap?.language === "es" ? "es" : "en"
  const t = (key: ModuleTextKey) => moduleText(lang, key)
  const theme = palette(snap?.brand)
  const styles = useMemo(() => panelStyles(theme), [theme])
  const [store, setStore] = useState<StoreId>("target")
  const [draft, setDraft] = useState<ModuleRecord>(snap?.modules?.target ?? {})
  const [preset, setPreset] = useState("")

  function choose(next: StoreId) {
    setStore(next)
    setDraft(snap?.modules?.[next] ?? {})
  }

  const scope = {
    modules: snap?.modules,
    monitorDelayMs: snap?.moduleGlobals?.monitorDelayMs ?? 3500,
    sessionWarmupMin: snap?.moduleGlobals?.sessionWarmupMin ?? 30,
    blockRetries: snap?.moduleGlobals?.blockRetries ?? 3,
    testMode: snap?.moduleGlobals?.testMode === true,
    monitorZips: snap?.moduleGlobals?.monitorZips ?? "",
    monitorStoreIds: snap?.moduleGlobals?.monitorStoreIds ?? "",
    targetZip: snap?.moduleGlobals?.targetZip ?? "",
    targetStoreId: snap?.moduleGlobals?.targetStoreId ?? ""
  }
  const resolved = resolveModule(store, scope)
  const recommended = recommendedModule(store)
  const shown: ModuleField[] = ["monitorDelayMs", "retryDelayMs", "rateLimitMs", "queue", "atcMode", "soldBy", "maxRetries", "testMode", "blockBackoffMs"]

  return (
    <View>
      <Text style={styles.h2}>{t("phoneTitle")}</Text>
      <Text style={styles.p}>{t("intro")}</Text>
      <View style={styles.row}>
        {STORE_CATALOG.map((item) => (
          <Pressable key={item.id} style={item.id === store ? styles.primary : styles.secondary} onPress={() => choose(item.id)}>
            <Text style={item.id === store ? styles.primaryText : styles.secondaryText}>{item.name}</Text>
          </Pressable>
        ))}
        <Pressable style={styles.secondary} onPress={onBack}><Text style={styles.secondaryText}>{t("phoneBack")}</Text></Pressable>
      </View>
      {shown.map((field) => (
        <View key={field}>
          <Text style={styles.label}>{t(field)}</Text>
          <Text style={styles.p}>{t("from")}: {sourceLabel(lang, resolved[field].source)} · {String(resolved[field].value)}</Text>
          {field === "queue" || field === "atcMode" || field === "soldBy" || field === "testMode" ? (
            <View style={styles.row}>
              {options(field).map((choice) => (
                <Pressable key={choice} style={styles.secondary} onPress={() => setDraft({ ...draft, [field]: field === "testMode" ? choice === "on" : choice } as ModuleRecord)}>
                  <Text style={styles.secondaryText}>{field === "testMode" ? t(choice as ModuleTextKey) : t(choice as ModuleTextKey)}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <TextInput
              value={draft[field] === undefined ? "" : String(draft[field])}
              onChangeText={(value) => setDraft({ ...draft, [field]: value.trim() ? Math.round(Number(value)) : undefined })}
              keyboardType="number-pad"
              placeholder={String(recommended[field])}
              placeholderTextColor={theme.muted}
              style={styles.input}
            />
          )}
        </View>
      ))}
      {scope.testMode ? <Text style={styles.p}>{t("testForced")}</Text> : null}
      <Pressable style={styles.primary} onPress={() => void onRun(() => session!.saveModule(store, draft))}><Text style={styles.primaryText}>{t("save")}</Text></Pressable>
      <Pressable style={styles.secondary} onPress={() => void onRun(async () => {
        const result = await session!.resetModule(store)
        if (result.ok) setDraft({})
        return result
      })}><Text style={styles.secondaryText}>{t("reset")}</Text></Pressable>
      <Text style={styles.label}>{t("import")}</Text>
      <TextInput value={preset} onChangeText={setPreset} placeholder={exportModulePreset(store, scope)} placeholderTextColor={theme.muted} style={styles.input} multiline />
      <Pressable style={styles.secondary} onPress={() => void onRun(() => session!.importModule(preset || exportModulePreset(store, scope)))}><Text style={styles.secondaryText}>{t("importAction")}</Text></Pressable>
    </View>
  )
}

function options(field: ModuleField): string[] {
  if (field === "queue") return ["wait", "skip", "pause"]
  if (field === "atcMode") return ["fast", "standard"]
  if (field === "soldBy") return ["retailer", "any"]
  if (field === "testMode") return ["off", "on"]
  return []
}

function panelStyles(c: ReturnType<typeof palette>) {
  return StyleSheet.create({
    h2: { color: c.text, fontSize: 18, fontWeight: "700", marginTop: 8 },
    p: { color: c.muted, fontSize: 14, lineHeight: 20 },
    label: { color: c.text, fontSize: 13, marginTop: 8 },
    input: { backgroundColor: c.card2, color: c.text, borderColor: c.line, borderWidth: 1, borderRadius: 8, padding: 10 },
    row: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    primary: { backgroundColor: c.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, alignSelf: "flex-start" },
    primaryText: { color: c.accentInk, fontWeight: "700" },
    secondary: { borderColor: c.line, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, alignSelf: "flex-start" },
    secondaryText: { color: c.text }
  })
}
