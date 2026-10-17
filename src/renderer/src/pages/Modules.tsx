import { useEffect, useState } from "react"
import { STORE_CATALOG } from "../../../shared/stores"
import {
  MODULE_ENDPOINTS,
  MODULE_FIELDS,
  exportModulePreset,
  moduleScope,
  moduleText,
  moduleUsesGlobal,
  recommendedModule,
  resolveModule,
  sourceLabel,
  type ModuleField,
  type ModuleTextKey
} from "../../../shared/module-settings"
import type { MailLang } from "../../../shared/mail"
import type { ModuleRecord, Settings, StoreId } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function ModulesPage() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [store, setStore] = useState<StoreId>("target")
  const [draft, setDraft] = useState<ModuleRecord>({})
  const [preset, setPreset] = useState("")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  const lang: MailLang = settings?.language === "es" ? "es" : "en"
  const t = (key: ModuleTextKey) => moduleText(lang, key)

  useEffect(() => {
    void unwrap(window.aio.settings.get()).then((payload) => {
      setSettings(payload.settings)
      setDraft(payload.settings.modules.target ?? {})
      setPreset(exportModulePreset("target", moduleScope(payload.settings)))
    }).catch((err) => setError(errorText(err)))
  }, [])

  function choose(next: StoreId, current = settings) {
    setStore(next)
    setDraft(current?.modules[next] ?? {})
    if (current) setPreset(exportModulePreset(next, moduleScope(current)))
    setMessage("")
    setError("")
  }

  async function saveLanguage(next: MailLang) {
    if (!settings) return
    const saved = await unwrap(window.aio.settings.save({ ...settings, language: next }))
    setSettings(saved.settings)
  }

  function apply(saved: Settings, note: string) {
    setSettings(saved)
    setDraft(saved.modules[store] ?? {})
    setPreset(exportModulePreset(store, moduleScope(saved)))
    setMessage(note)
  }

  async function save() {
    setBusy(true)
    setError("")
    try {
      const payload = await unwrap(window.aio.settings.saveModule(store, draft))
      apply(payload.settings, t("saved"))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function reset() {
    setBusy(true)
    setError("")
    try {
      const payload = await unwrap(window.aio.settings.resetModule(store))
      apply(payload.settings, t("resetDone"))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function importPreset() {
    setBusy(true)
    setError("")
    try {
      const payload = await unwrap(window.aio.settings.importModule(preset))
      const imported = payload.settings
      setSettings(imported)
      const match = Object.keys(imported.modules).find((id) => imported.modules[id as StoreId] && preset.includes(`"store": "${id}"`)) as StoreId | undefined
      const next = match && STORE_CATALOG.some((item) => item.id === match) ? match : store
      setStore(next)
      setDraft(imported.modules[next] ?? {})
      setPreset(exportModulePreset(next, moduleScope(imported)))
      setMessage(t("imported"))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!settings) return <section className="page"><h1>{t("title")}</h1>{error ? <Banner tone="error">{error}</Banner> : null}</section>

  const resolved = resolveModule(store, moduleScope(settings))
  const recommended = recommendedModule(store)
  const useGlobal = new Set<string>(draft.useGlobal ?? [])

  function setField(field: ModuleField, value: string | boolean) {
    setDraft((current) => {
      const next = { ...current }
      if (field === "testMode") next.testMode = value === true
      else if (field === "queue" || field === "atcMode" || field === "soldBy" || field === "endpoint" || field === "zips" || field === "storeIds") next[field] = String(value) as never
      else next[field] = Math.round(Number(value)) as never
      return next
    })
  }

  function toggleGlobal(field: ModuleField, on: boolean) {
    if (!moduleUsesGlobal(field)) return
    const key = field as NonNullable<ModuleRecord["useGlobal"]>[number]
    setDraft((current) => {
      const list = new Set(current.useGlobal ?? [])
      if (on) list.add(key)
      else list.delete(key)
      return { ...current, useGlobal: [...list] }
    })
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>{t("title")}</h1>
          <p>{t("intro")}</p>
        </div>
        <Select value={lang} onChange={(event) => void saveLanguage(event.target.value === "es" ? "es" : "en")} aria-label={t("from")}>
          <option value="en">English</option>
          <option value="es">Español</option>
        </Select>
      </div>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      <div className="actions">
        {STORE_CATALOG.map((item) => (
          <button key={item.id} type="button" className={item.id === store ? "primary" : ""} onClick={() => choose(item.id)}>{item.name}</button>
        ))}
      </div>
      <div className="card form-grid">
        {MODULE_FIELDS.map((field) => {
          const origin = resolved[field]
          const globalOn = useGlobal.has(field)
          return (
            <Field key={field} label={t(field)} hint={`${t("from")}: ${sourceLabel(lang, origin.source)} · ${String(origin.value)}`}>
              {field === "endpoint" ? (
                <Select value={draft.endpoint ?? recommended.endpoint} onChange={(event) => setField(field, event.target.value)}>
                  {MODULE_ENDPOINTS[store].map((endpoint) => <option key={endpoint} value={endpoint}>{endpoint}</option>)}
                </Select>
              ) : field === "queue" || field === "atcMode" || field === "soldBy" ? (
                <Select value={String(draft[field] ?? recommended[field])} onChange={(event) => setField(field, event.target.value)}>
                  {choices(field).map((choice) => <option key={choice} value={choice}>{t(choice as ModuleTextKey)}</option>)}
                </Select>
              ) : field === "testMode" ? (
                <Select value={(draft.testMode ?? recommended.testMode) ? "on" : "off"} onChange={(event) => setField(field, event.target.value === "on")} disabled={globalOn}>
                  <option value="off">{t("off")}</option>
                  <option value="on">{t("on")}</option>
                </Select>
              ) : field === "zips" || field === "storeIds" ? (
                <TextInput value={draft[field] ?? ""} placeholder={String(recommended[field] || origin.value)} onChange={(event) => setField(field, event.target.value)} disabled={globalOn} />
              ) : (
                <TextInput type="number" value={draft[field] ?? recommended[field]} onChange={(event) => setField(field, event.target.value)} disabled={globalOn} />
              )}
              {moduleUsesGlobal(field) ? (
                <label className="check"><input type="checkbox" checked={globalOn} onChange={(event) => toggleGlobal(field, event.target.checked)} /><span>{t("useGlobal")}</span></label>
              ) : null}
            </Field>
          )
        })}
        {settings.testMode ? <Banner tone="info">{t("testForced")}</Banner> : null}
        <div className="actions span-2">
          <button type="button" className="primary" disabled={busy} onClick={() => void save()}>{t("save")}</button>
          <button type="button" disabled={busy} onClick={() => void reset()}>{t("reset")}</button>
        </div>
      </div>
      <div className="card form-grid">
        <Field className="span-2" label={t("export")}>
          <textarea value={preset} onChange={(event) => setPreset(event.target.value)} rows={8} />
        </Field>
        <div className="actions span-2">
          <button type="button" disabled={busy} onClick={() => void importPreset()}>{t("importAction")}</button>
        </div>
      </div>
    </section>
  )
}

function choices(field: ModuleField): string[] {
  if (field === "queue") return ["wait", "skip", "pause"]
  if (field === "atcMode") return ["fast", "standard"]
  if (field === "soldBy") return ["retailer", "any"]
  return []
}
