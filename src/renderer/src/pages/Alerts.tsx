import { useEffect, useState } from "react"
import { STORE_IDS, type AlertsView, type DiscordWatchInput, type KeywordWatch, type KeywordWatchInput, type ProxyGroup, type PublicAccount, type PublicProfile, type PublicTask, type RestockRule, type RestockRuleInput, type StoreId, type StoreInfo } from "../../../shared/types"
import { dropOpsText } from "../../../shared/drop-ops"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

const SAMPLE = `{
  "store": "target",
  "sku": "88897904",
  "title": "Pokemon TCG Elite Trainer Box",
  "price": 49.99,
  "url": "https://www.target.com/p/-/A-88897904",
  "quantity": 1,
  "inStock": true,
  "soldBy": "Target",
  "source": "restockr"
}`

const emptyRule = (): RestockRuleInput => ({
  name: "",
  enabled: true,
  store: "target",
  sku: "",
  keywords: "",
  taskId: null,
  profileId: "",
  accountId: "",
  proxyGroupId: null,
  quantity: 1,
  maxQuantity: 1,
  maxPrice: null,
  cooldownSec: 300,
  testMode: true,
  confirmPurchase: false
})

const emptyWatch = (): KeywordWatchInput => ({
  name: "",
  enabled: true,
  store: "target",
  keywords: "+elite +trainer +box +pokemon -sleeves",
  maxPrice: null,
  soldByRetailer: true,
  proxyGroupId: null,
  profileId: "",
  accountId: "",
  quantity: 1,
  maxQuantity: 1,
  autoStart: false,
  testMode: true,
  confirmPurchase: false
})

export function AlertsPage() {
  const [view, setView] = useState<AlertsView | null>(null)
  const [profiles, setProfiles] = useState<PublicProfile[]>([])
  const [accounts, setAccounts] = useState<PublicAccount[]>([])
  const [groups, setGroups] = useState<ProxyGroup[]>([])
  const [tasks, setTasks] = useState<PublicTask[]>([])
  const [stores, setStores] = useState<StoreInfo[]>([])
  const [rule, setRule] = useState<RestockRuleInput | null>(null)
  const [watch, setWatch] = useState<KeywordWatchInput | null>(null)
  const [discord, setDiscord] = useState<DiscordWatchInput>({ channelId: "", channelIds: "", allowlist: "", dedupeMin: 30, enabled: false, token: "", tokenAction: "keep" })
  const [lang, setLang] = useState<"en" | "es">("en")
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)

  async function reload() {
    const [next, nextProfiles, nextAccounts, nextGroups, nextTasks, nextStores] = await Promise.all([
      unwrap(window.aio.alerts.get()),
      unwrap(window.aio.profiles.list()),
      unwrap(window.aio.accounts.list()),
      unwrap(window.aio.proxies.list()),
      unwrap(window.aio.tasks.list()),
      unwrap(window.aio.stores.list())
    ])
    setView(next)
    setProfiles(nextProfiles)
    setAccounts(nextAccounts)
    setGroups(nextGroups)
    setTasks(nextTasks)
    setStores(nextStores)
    setDiscord((current) => ({
      ...current,
      channelId: next.channelId,
      channelIds: next.channelIds || next.channelId,
      allowlist: next.allowlist,
      dedupeMin: next.dedupeMin,
      enabled: next.discordWatch,
      token: "",
      tokenAction: "keep"
    }))
    const settings = await unwrap(window.aio.settings.get())
    setLang(settings.settings.language === "es" ? "es" : "en")
  }

  useEffect(() => {
    void reload().catch((err) => setError(errorText(err)))
    return window.aio.alerts.onEvent((next) => setView(next))
  }, [])

  async function run(action: () => Promise<void>, ok: string) {
    setBusy(true)
    setError("")
    setMessage("")
    try {
      await action()
      setMessage(ok)
      await reload()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function quickMonitor(store: string, sku: string, profileId: string, accountId: string, proxyGroupId: string | null, quantity: number) {
    if (!STORE_IDS.includes(store as StoreId)) throw new Error("This alert does not name one store.")
    if (!sku.trim()) throw new Error("This alert does not name a SKU.")
    const profile = profileId || profiles[0]?.id || ""
    const account = accountId || accounts.find((item) => item.store === store)?.id || ""
    if (!profile || !account) throw new Error("Save a profile and an account for this store first.")
    await unwrap(window.aio.tasks.save({
      store: store as StoreId,
      sku: sku.trim(),
      quantity: quantity || 1,
      profileId: profile,
      accountId: account,
      proxyGroupId,
      confirmPurchase: false,
      testMode: true,
      monitorOnly: true,
      group: "Alert"
    }))
  }

  const ruleAccounts = accounts.filter((account) => !rule?.store || account.store === rule.store)
  const watchAccounts = accounts.filter((account) => account.store === watch?.store)

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>Alerts</h1>
          <p>Restock signals and keyword searches can notify you and start a task. Test mode still stops before place order.</p>
        </div>
      </header>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}

      <div className="card stack">
        <h2>Restock webhook</h2>
        <p>POST this JSON with <span className="mono">Authorization: Bearer &lt;token&gt;</span>. A Discord bot message or RestockR can send the same object. Out-of-stock signals are ignored.</p>
        <pre className="sample">{SAMPLE}</pre>
        <p className="mono">Local: {view?.localUrl || "Starting…"}</p>
        <p className="mono">Relay: {view?.relayUrl || "No relay saved. The local URL works on this network."}</p>
        <p className="mono">Token: {view?.token || "Not created yet."}</p>
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => void run(async () => { await unwrap(window.aio.alerts.rotateToken()) }, "Webhook token rotated. Update RestockR or your bot.")}>Rotate token</button>
        </div>
      </div>

      <form className="card form-grid" onSubmit={(event) => {
        event.preventDefault()
        void run(async () => { await unwrap(window.aio.alerts.saveDiscord(discord)) }, "Discord watcher saved.")
      }}>
        <h2 className="span-2">Discord channel watcher</h2>
        <p className="span-2">A bot you create reads the channels you list for SKUs, product links, or the JSON above. The token stays on this PC and is not sent to the phone. Messages already in a channel are ignored when that channel is first armed.</p>
        <Field label="Bot token" hint={view?.hasBot ? "Saved. Leave blank to keep it." : "Required to turn the watcher on."}>
          <TextInput type="password" value={discord.token} autoComplete="off" onChange={(event) => setDiscord({ ...discord, token: event.target.value, tokenAction: event.target.value ? "replace" : "keep" })} />
        </Field>
        <Field className="span-2" label={dropOpsText(lang, "channels")} hint={dropOpsText(lang, "channelsHint")}>
          <textarea rows={3} value={discord.channelIds ?? ""} onChange={(event) => setDiscord({ ...discord, channelIds: event.target.value, channelId: event.target.value })} placeholder="123456789012345678" />
        </Field>
        <Field className="span-2" label={dropOpsText(lang, "allowlist")} hint={dropOpsText(lang, "allowlistHint")}>
          <textarea rows={3} value={discord.allowlist ?? ""} onChange={(event) => setDiscord({ ...discord, allowlist: event.target.value })} />
        </Field>
        <Field label={dropOpsText(lang, "dedupe")} hint={dropOpsText(lang, "dedupeHint")}>
          <TextInput type="number" min={0} max={1440} value={discord.dedupeMin ?? 30} onChange={(event) => setDiscord({ ...discord, dedupeMin: Number(event.target.value) })} />
        </Field>
        <label className="check span-2">
          <input type="checkbox" checked={discord.enabled} onChange={(event) => setDiscord({ ...discord, enabled: event.target.checked })} />
          <span>Watch this channel and match restock rules.</span>
        </label>
        <div className="actions span-2">
          <button className="primary" disabled={busy}>Save Discord watcher</button>
          {view?.hasBot ? <button type="button" disabled={busy} onClick={() => void run(async () => { await unwrap(window.aio.alerts.saveDiscord({ ...discord, token: "", tokenAction: "clear", enabled: false })) }, "Bot token removed.")}>Remove token</button> : null}
        </div>
      </form>

      <div className="card stack">
        <div className="proxy-head">
          <h2>Restock rules</h2>
          <button type="button" onClick={() => setRule(emptyRule())}>New rule</button>
        </div>
        {rule ? (
          <form className="form-grid" onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              await unwrap(window.aio.alerts.saveRule(rule))
              setRule(null)
            }, "Rule saved.")
          }}>
            <Field label="Name"><TextInput value={rule.name} onChange={(event) => setRule({ ...rule, name: event.target.value })} required /></Field>
            <Field label="Store" hint="Any store matches every signal.">
              <Select value={rule.store} onChange={(event) => setRule({ ...rule, store: event.target.value as RestockRuleInput["store"], accountId: "" })}>
                <option value="">Any store</option>
                {stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}
              </Select>
            </Field>
            <Field label="SKU" hint="Leave blank to match keywords only."><TextInput value={rule.sku} onChange={(event) => setRule({ ...rule, sku: event.target.value })} /></Field>
            <Field label="Keywords" hint="+elite +trainer -sleeves. All plain words must appear."><TextInput value={rule.keywords} onChange={(event) => setRule({ ...rule, keywords: event.target.value })} /></Field>
            <Field label="Template task" hint="Blank creates a new task from the profile below.">
              <Select value={rule.taskId ?? ""} onChange={(event) => setRule({ ...rule, taskId: event.target.value || null })}>
                <option value="">Create a task</option>
                {tasks.filter((task) => !rule.store || task.store === rule.store).map((task) => <option key={task.id} value={task.id}>{task.store} · {task.sku}</option>)}
              </Select>
            </Field>
            <Field label="Profile"><Select value={rule.profileId} onChange={(event) => setRule({ ...rule, profileId: event.target.value })}><option value="">Choose</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</Select></Field>
            <Field label="Account"><Select value={rule.accountId} onChange={(event) => setRule({ ...rule, accountId: event.target.value })}><option value="">Choose</option>{ruleAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</Select></Field>
            <Field label="Proxy group"><Select value={rule.proxyGroupId ?? ""} onChange={(event) => setRule({ ...rule, proxyGroupId: event.target.value || null })}><option value="">Direct</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</Select></Field>
            <Field label="Quantity"><TextInput type="number" min={1} max={12} value={rule.quantity} onChange={(event) => setRule({ ...rule, quantity: Number(event.target.value) })} /></Field>
            <Field label="Max quantity"><TextInput type="number" min={1} max={12} value={rule.maxQuantity} onChange={(event) => setRule({ ...rule, maxQuantity: Number(event.target.value) })} /></Field>
            <Field label="Max price" hint="Blank means no cap. A signal without a price will not fire."><TextInput value={rule.maxPrice ?? ""} onChange={(event) => setRule({ ...rule, maxPrice: event.target.value === "" ? null : Number(event.target.value) })} /></Field>
            <Field label="Cooldown seconds"><TextInput type="number" min={0} max={86400} value={rule.cooldownSec} onChange={(event) => setRule({ ...rule, cooldownSec: Number(event.target.value) })} /></Field>
            <label className="check"><input type="checkbox" checked={rule.enabled} onChange={(event) => setRule({ ...rule, enabled: event.target.checked })} /><span>Rule on</span></label>
            <label className="check"><input type="checkbox" checked={rule.testMode} onChange={(event) => setRule({ ...rule, testMode: event.target.checked })} /><span>Test mode. Stops before place order.</span></label>
            <label className="check span-2"><input type="checkbox" checked={rule.confirmPurchase} onChange={(event) => setRule({ ...rule, confirmPurchase: event.target.checked })} /><span>This rule may place a real order when test mode is off.</span></label>
            <div className="actions span-2">
              <button className="primary" disabled={busy}>Save rule</button>
              <button type="button" onClick={() => setRule(null)}>Cancel</button>
            </div>
          </form>
        ) : null}
        {view?.rules.length ? view.rules.map((item) => (
          <article key={item.id} className="proxy-results">
            <div className="proxy-head">
              <strong>{item.name}</strong>
              <span>{item.enabled ? "On" : "Off"}{item.testMode ? " · TEST" : ""}</span>
            </div>
            <span>{item.store || "Any store"} · {item.sku || item.keywords || "No match"} · cap {item.maxQuantity} · {item.maxPrice === null ? "no price cap" : `$${item.maxPrice}`} · {item.cooldownSec}s</span>
            <div className="row-actions">
              <button type="button" disabled={!item.store || !item.sku} onClick={() => void run(async () => { await quickMonitor(item.store, item.sku, item.profileId, item.accountId, item.proxyGroupId, item.quantity) }, "Monitor-only task created. It does not add to cart.")}>Quick task</button>
              <button type="button" onClick={() => setRule(ruleInput(item))}>Edit</button>
              <button type="button" onClick={() => void run(async () => { await unwrap(window.aio.alerts.saveRule({ ...ruleInput(item), enabled: !item.enabled })) }, item.enabled ? "Rule off." : "Rule on.")}>{item.enabled ? "Turn off" : "Turn on"}</button>
              <button type="button" className="danger" onClick={() => void run(async () => { await unwrap(window.aio.alerts.deleteRule(item.id)) }, "Rule deleted.")}>Delete</button>
            </div>
          </article>
        )) : <p>No rules yet. A signal does nothing until a rule matches its store and SKU or keywords.</p>}
      </div>

      <div className="card stack">
        <div className="proxy-head">
          <h2>Keyword monitors</h2>
          <button type="button" onClick={() => setWatch(emptyWatch())}>New watch</button>
        </div>
        <p>Each watch searches one store on the monitor delay, at least every 5 seconds, through the proxy group. A block pauses the watch and sends Discord plus the phone. Resume tries the next proxy.</p>
        {watch ? (
          <form className="form-grid" onSubmit={(event) => {
            event.preventDefault()
            void run(async () => {
              await unwrap(window.aio.alerts.saveWatch(watch))
              setWatch(null)
            }, "Watch saved.")
          }}>
            <Field label="Name"><TextInput value={watch.name} onChange={(event) => setWatch({ ...watch, name: event.target.value })} required /></Field>
            <Field label="Store"><Select value={watch.store} onChange={(event) => setWatch({ ...watch, store: event.target.value as KeywordWatchInput["store"], accountId: "" })}>{stores.map((store) => <option key={store.id} value={store.id}>{store.name}</option>)}</Select></Field>
            <Field className="span-2" label="Keywords" hint="Example: +elite +trainer +box +pokemon -sleeves"><TextInput value={watch.keywords} onChange={(event) => setWatch({ ...watch, keywords: event.target.value })} required /></Field>
            <Field label="Max price"><TextInput value={watch.maxPrice ?? ""} onChange={(event) => setWatch({ ...watch, maxPrice: event.target.value === "" ? null : Number(event.target.value) })} /></Field>
            <Field label="Quantity"><TextInput type="number" min={1} max={12} value={watch.quantity} onChange={(event) => setWatch({ ...watch, quantity: Number(event.target.value) })} /></Field>
            <Field label="Max quantity"><TextInput type="number" min={1} max={12} value={watch.maxQuantity} onChange={(event) => setWatch({ ...watch, maxQuantity: Number(event.target.value) })} /></Field>
            <Field label="Profile"><Select value={watch.profileId} onChange={(event) => setWatch({ ...watch, profileId: event.target.value })}><option value="">Choose</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</Select></Field>
            <Field label="Account"><Select value={watch.accountId} onChange={(event) => setWatch({ ...watch, accountId: event.target.value })}><option value="">Choose</option>{watchAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}</Select></Field>
            <Field label="Proxy group"><Select value={watch.proxyGroupId ?? ""} onChange={(event) => setWatch({ ...watch, proxyGroupId: event.target.value || null })}><option value="">Direct</option>{groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</Select></Field>
            <label className="check"><input type="checkbox" checked={watch.soldByRetailer !== false} onChange={(event) => setWatch({ ...watch, soldByRetailer: event.target.checked })} /><span>Sold by the retailer</span></label>
            <label className="check"><input type="checkbox" checked={watch.enabled} onChange={(event) => setWatch({ ...watch, enabled: event.target.checked })} /><span>Watch on</span></label>
            <label className="check"><input type="checkbox" checked={watch.autoStart === true} onChange={(event) => setWatch({ ...watch, autoStart: event.target.checked })} /><span>Auto-create and start a task</span></label>
            <label className="check"><input type="checkbox" checked={watch.testMode === true} onChange={(event) => setWatch({ ...watch, testMode: event.target.checked })} /><span>Test mode</span></label>
            <label className="check span-2"><input type="checkbox" checked={watch.confirmPurchase === true} onChange={(event) => setWatch({ ...watch, confirmPurchase: event.target.checked })} /><span>May place a real order when test mode is off.</span></label>
            <label className="check span-2"><input type="checkbox" checked={watch.resetSeen === true} onChange={(event) => setWatch({ ...watch, resetSeen: event.target.checked })} /><span>Forget products already seen</span></label>
            <div className="actions span-2">
              <button className="primary" disabled={busy}>Save watch</button>
              <button type="button" onClick={() => setWatch(null)}>Cancel</button>
            </div>
          </form>
        ) : null}
        {view?.watches.length ? view.watches.map((item) => (
          <article key={item.id} className="proxy-results">
            <div className="proxy-head">
              <strong>{item.name}</strong>
              <span className={`pill ${item.status}`}>{item.status}</span>
            </div>
            <span>{storeName(stores, item.store)} · {item.keywords}{item.testMode ? " · TEST" : ""}</span>
            <span>{item.detail}</span>
            <div className="row-actions">
              <button type="button" onClick={() => setWatch(watchInput(item))}>Edit</button>
              {item.status === "blocked" ? <button type="button" onClick={() => void run(async () => { await unwrap(window.aio.alerts.resumeWatch(item.id)) }, "Watch resumed.")}>Resume</button> : null}
              <button type="button" onClick={() => void run(async () => { await unwrap(window.aio.alerts.saveWatch({ ...watchInput(item), enabled: !item.enabled })) }, item.enabled ? "Watch off." : "Watch on.")}>{item.enabled ? "Turn off" : "Turn on"}</button>
              <button type="button" className="danger" onClick={() => void run(async () => { await unwrap(window.aio.alerts.deleteWatch(item.id)) }, "Watch deleted.")}>Delete</button>
            </div>
          </article>
        )) : <p>No keyword watches yet.</p>}
      </div>

      <div className="card log-card">
        <div className="log-head"><strong>Recent matches</strong><span>{view?.log.length ?? 0}</span></div>
        <div className="log">
          {view?.log.length ? view.log.map((entry) => (
            <div key={entry.id} className="log-line">
              <time>{new Date(entry.ts).toLocaleTimeString()}</time>
              <span>{entry.source} · {entry.store} {entry.sku} · {entry.result}</span>
              <button type="button" disabled={!entry.sku || !STORE_IDS.includes(entry.store as StoreId)} onClick={() => {
                const matched = view?.rules.find((rule) => (!rule.store || rule.store === entry.store) && (!rule.sku || rule.sku === entry.sku))
                void run(async () => { await quickMonitor(entry.store, entry.sku, matched?.profileId ?? "", matched?.accountId ?? "", matched?.proxyGroupId ?? null, matched?.quantity ?? 1) }, "Monitor-only task created from the alert.")
              }}>Quick task</button>
            </div>
          )) : <p className="empty">No restock or keyword events yet.</p>}
        </div>
      </div>
    </section>
  )
}

function ruleInput(rule: RestockRule): RestockRuleInput {
  return { ...rule, taskId: rule.taskId }
}

function watchInput(watch: KeywordWatch): KeywordWatchInput {
  return { ...watch, resetSeen: false }
}

function storeName(stores: StoreInfo[], id: string): string {
  return stores.find((store) => store.id === id)?.name ?? id
}
