import { useState, type ReactNode } from "react"
import { deskText } from "../../../shared/desk-ui"
import { builtinRole, prefillRole, type RoleDefaults, type RolePatch, type TaskRoleName } from "../../../shared/store-defaults"
import { STORE_CATALOG } from "../../../shared/stores"
import type { Settings, StoreId } from "../../../shared/types"
import { Field, Select, TextInput } from "../components/ui"
import { unwrap } from "../lib"

export function StoreDefaults({ settings, onSaved }: { settings: Settings; onSaved: (next: Settings) => void }) {
  const lang = settings.language === "es" ? "es" : "en"
  const [store, setStore] = useState<StoreId>("target")
  const [role, setRole] = useState<TaskRoleName>("checkout")
  const [error, setError] = useState("")
  const saved = settings.storeRoles?.[store]?.[role] ?? {}
  const values = prefillRole(store, role, settings.storeRoles)
  const builtin = builtinRole(store, role)

  async function save(patch: RolePatch | undefined, addressCap?: number | null) {
    setError("")
    const storeRoles = { ...settings.storeRoles, [store]: { ...settings.storeRoles?.[store], [role]: patch } }
    if (!patch) {
      const row = { ...storeRoles[store] }
      delete row[role]
      storeRoles[store] = row
    }
    const addressOrderLimits = role === "checkout" && addressCap !== undefined
      ? addressLine(settings.addressOrderLimits, store, addressCap)
      : settings.addressOrderLimits
    try {
      const next = await unwrap(window.aio.settings.save({ ...settings, storeRoles, addressOrderLimits }))
      onSaved(next.settings)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.")
    }
  }

  function setField<K extends keyof RoleDefaults>(key: K, value: RoleDefaults[K]) {
    const patch: RolePatch = { ...saved, [key]: value }
    if (value === builtin[key]) delete patch[key]
    const addressCap = key === "addressOrderLimit" ? (value === builtin.addressOrderLimit ? null : Number(value)) : undefined
    void save(Object.keys(patch).length ? patch : undefined, addressCap)
  }

  return (
    <section className="card stack">
      <header className="page-head">
        <div>
          <h2>{deskText(lang, "storeDefaults")}</h2>
          <p>{deskText(lang, "storeDefaultsHint")}</p>
        </div>
        <button type="button" onClick={() => void save(undefined, role === "checkout" ? null : undefined)}>{deskText(lang, "resetRecommended")}</button>
      </header>
      {error ? <p className="banner error">{error}</p> : null}
      <div className="segments" role="tablist">
        <Select aria-label={deskText(lang, "storeDefaults")} value={store} onChange={(event) => setStore(event.target.value as StoreId)}>
          {STORE_CATALOG.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
        <button type="button" aria-pressed={role === "monitor"} onClick={() => setRole("monitor")}>{deskText(lang, "tabMonitor")}</button>
        <button type="button" aria-pressed={role === "checkout"} onClick={() => setRole("checkout")}>{deskText(lang, "tabCheckout")}</button>
      </div>
      <div className="form-grid">
        <MarkField label={deskText(lang, "fieldInterval")} mark={saved.monitorDelayMs == null ? "default" : "custom"} lang={lang}>
          <TextInput inputMode="numeric" value={String(values.monitorDelayMs)} onChange={(event) => setField("monitorDelayMs", Number(event.target.value))} />
        </MarkField>
        <MarkField label={deskText(lang, "fieldRetry")} mark={saved.retryDelayMs == null ? "default" : "custom"} lang={lang}>
          <TextInput inputMode="numeric" value={String(values.retryDelayMs)} onChange={(event) => setField("retryDelayMs", Number(event.target.value))} />
        </MarkField>
        <MarkField label={deskText(lang, "fieldQueue")} mark={saved.queue == null ? "default" : "custom"} lang={lang}>
          <Select value={values.queue} onChange={(event) => setField("queue", event.target.value as RoleDefaults["queue"])}>
            <option value="wait">{deskText(lang, "queueWait")}</option>
            <option value="pause">{deskText(lang, "queuePause")}</option>
            <option value="skip">{deskText(lang, "queueSkip")}</option>
          </Select>
        </MarkField>
        <MarkField label={deskText(lang, "fieldQuantity")} mark={saved.quantity == null ? "default" : "custom"} lang={lang}>
          <TextInput inputMode="numeric" value={String(values.quantity)} onChange={(event) => setField("quantity", Number(event.target.value))} />
        </MarkField>
        <MarkField label={deskText(lang, "fieldAddressCap")} mark={saved.addressOrderLimit == null ? "default" : "custom"} lang={lang}>
          <TextInput inputMode="numeric" value={String(values.addressOrderLimit)} onChange={(event) => setField("addressOrderLimit", Number(event.target.value))} />
        </MarkField>
        <MarkField label={deskText(lang, "fieldWarm")} mark={saved.warmOnStart == null ? "default" : "custom"} lang={lang}>
          <Select value={values.warmOnStart ? "yes" : "no"} onChange={(event) => setField("warmOnStart", event.target.value === "yes")}>
            <option value="yes">{deskText(lang, "yes")}</option>
            <option value="no">{deskText(lang, "no")}</option>
          </Select>
        </MarkField>
      </div>
    </section>
  )
}

function addressLine(current: string, store: string, cap: number | null): string {
  const lines = current.split(/\n+/).map((line) => line.trim()).filter((line) => {
    if (!line) return false
    const name = line.split(/[:=]/)[0]?.trim().toLowerCase()
    return name !== store
  })
  if (cap != null) lines.push(`${store}:${cap}`)
  return lines.join("\n")
}

function MarkField({ label, mark, lang, children }: { label: string; mark: "default" | "custom"; lang: "en" | "es"; children: ReactNode }) {
  return (
    <Field label={label} hint={deskText(lang, mark === "custom" ? "markCustom" : "markDefault")}>
      {children}
    </Field>
  )
}
