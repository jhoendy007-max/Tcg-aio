import { useEffect, useMemo, useState } from "react"
import { issueText, type HealthReport } from "../../../shared/checkout-health"
import { clientIdOf, clientText, ME_CLIENT_ID, proxyGroupTakenBy, type Client } from "../../../shared/clients"
import { planExtraCheckout, planQuickPair } from "../../../shared/quick-setup"
import { taskText } from "../../../shared/task-role"
import type { MailLang } from "../../../shared/mail"
import type { ProxyGroup, PublicAccount, PublicProfile, PublicTask, StoreId, StoreInfo } from "../../../shared/types"
import { Banner, Field, Select, TextInput } from "../components/ui"
import { errorText, unwrap } from "../lib"

export function QuickSetup({
  lang,
  stores,
  profiles,
  accounts,
  clients,
  groups,
  tasks,
  globalTest,
  warmOnStart,
  onCreated,
  onWarm
}: {
  lang: MailLang
  stores: StoreInfo[]
  profiles: PublicProfile[]
  accounts: PublicAccount[]
  clients: Client[]
  groups: ProxyGroup[]
  tasks: PublicTask[]
  globalTest: boolean
  warmOnStart: boolean
  onCreated: () => Promise<void>
  onWarm: (enabled: boolean) => Promise<void>
}) {
  const [store, setStore] = useState<StoreId>(stores[0]?.id ?? "target")
  const [clientId, setClientId] = useState(ME_CLIENT_ID)
  const [sku, setSku] = useState("")
  const [keywords, setKeywords] = useState("")
  const [profileId, setProfileId] = useState(() => profiles.find((profile) => clientIdOf(profile.clientId) === ME_CLIENT_ID)?.id ?? "")
  const [accountId, setAccountId] = useState("")
  const [proxyGroupId, setProxyGroupId] = useState("")
  const [quantity, setQuantity] = useState(1)
  const [testMode, setTestMode] = useState(true)
  const [confirmPurchase, setConfirmPurchase] = useState(false)
  const [newAccount, setNewAccount] = useState(false)
  const [label, setLabel] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [warm, setWarm] = useState(warmOnStart)
  const [monitorId, setMonitorId] = useState<string | null>(null)
  const [extraAccountId, setExtraAccountId] = useState("")
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<HealthReport | null>(null)

  const storeAccounts = useMemo(
    () => accounts.filter((account) => account.store === store && clientIdOf(account.clientId) === clientId),
    [accounts, store, clientId]
  )
  const clientProfiles = useMemo(
    () => profiles.filter((profile) => clientIdOf(profile.clientId) === clientId),
    [profiles, clientId]
  )
  const openGroups = useMemo(
    () => groups.filter((group) => proxyGroupTakenBy(
      accounts.map((account) => ({ id: account.id, clientId: account.clientId, proxyGroupId: account.proxyGroupId ?? null })),
      undefined,
      clientId,
      group.id
    ) === null),
    [groups, accounts, clientId]
  )
  const selectedStore = stores.find((item) => item.id === store)
  const made = tasks.find((task) => task.id === monitorId && task.kind === "monitor") ?? null
  const clientOptions = clients.length ? clients : [{ id: ME_CLIENT_ID, name: clientText(lang, "me") }]
  const blocked = report?.blocked === true

  useEffect(() => {
    let cancel = false
    void unwrap(window.aio.checkoutHealth.preview({
      store,
      sku,
      quantity,
      profileId: profileId || undefined,
      accountId: newAccount ? undefined : accountId || undefined,
      clientId
    })).then((next) => {
      if (!cancel) setReport(next)
    }).catch(() => {
      if (!cancel) setReport(null)
    })
    return () => { cancel = true }
  }, [store, sku, quantity, profileId, accountId, clientId, newAccount])

  function chooseClient(next: string) {
    setClientId(next)
    const nextProfiles = profiles.filter((profile) => clientIdOf(profile.clientId) === next)
    setProfileId(nextProfiles[0]?.id ?? "")
    setAccountId("")
    setExtraAccountId("")
    if (proxyGroupId && proxyGroupTakenBy(
      accounts.map((account) => ({ id: account.id, clientId: account.clientId, proxyGroupId: account.proxyGroupId ?? null })),
      undefined,
      next,
      proxyGroupId
    )) setProxyGroupId("")
  }

  async function ensureAccount(): Promise<string> {
    if (!newAccount) {
      if (!accountId) throw new Error(taskText(lang, "quickPickAccount"))
      return accountId
    }
    const saved = await unwrap(window.aio.accounts.save({
      store,
      label,
      username: email,
      password,
      passwordAction: "replace",
      session: "",
      sessionAction: "keep",
      proxyGroupId: proxyGroupId || null,
      clientId
    }))
    setPassword("")
    setAccountId(saved.id)
    setNewAccount(false)
    return saved.id
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError("")
    setMessage("")
    try {
      if (warm !== warmOnStart) await onWarm(warm)
      const chosen = await ensureAccount()
      const account = accounts.find((item) => item.id === chosen)
      const profile = profiles.find((item) => item.id === profileId)
      if (account && clientIdOf(account.clientId) !== clientId) throw new Error(taskText(lang, "quickSameClient"))
      if (profile && clientIdOf(profile.clientId) !== clientId) throw new Error(taskText(lang, "quickSameClient"))
      const preview = await unwrap(window.aio.checkoutHealth.preview({
        store,
        sku,
        quantity,
        profileId: profileId || undefined,
        accountId: chosen,
        clientId
      }))
      if (preview.blocked) {
        throw new Error(preview.issues.filter((item) => item.level === "block").map((item) => issueText(lang, item)).join(" "))
      }
      const pair = planQuickPair({
        store,
        sku,
        keywords,
        profileId,
        accountId: chosen,
        proxyGroupId: proxyGroupId || null,
        quantity,
        testMode: testMode || globalTest,
        confirmPurchase,
        clientId
      })
      const monitor = await unwrap(window.aio.tasks.save(pair.monitor))
      const checkout = await unwrap(window.aio.tasks.save({ ...pair.checkout, linkedMonitorId: monitor.id }))
      await unwrap(window.aio.tasks.save({
        ...monitor,
        kind: "monitor",
        monitorOnly: true,
        linkedCheckoutIds: [checkout.id]
      }))
      setMonitorId(monitor.id)
      setMessage(taskText(lang, "quickMade"))
      await onCreated()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function addAccount() {
    if (!made || !extraAccountId) return
    setBusy(true)
    setError("")
    setMessage("")
    try {
      const owner = clientIdOf(made.clientId)
      const profile = profiles.find((item) => item.id === profileId)
      const account = accounts.find((item) => item.id === extraAccountId)
      if (!profile || clientIdOf(profile.clientId) !== owner || !account || clientIdOf(account.clientId) !== owner) {
        throw new Error(taskText(lang, "quickSameClient"))
      }
      const preview = await unwrap(window.aio.checkoutHealth.preview({
        store: made.store,
        sku: made.sku,
        quantity,
        profileId,
        accountId: extraAccountId,
        clientId: owner
      }))
      if (preview.blocked) {
        throw new Error(preview.issues.filter((item) => item.level === "block").map((item) => issueText(lang, item)).join(" "))
      }
      const extra = planExtraCheckout({
        id: made.id,
        store: made.store,
        sku: made.sku,
        keywords: made.keywords,
        proxyGroupId: proxyGroupId || null,
        group: made.group
      }, {
        profileId,
        accountId: extraAccountId,
        quantity,
        testMode: testMode || globalTest,
        confirmPurchase
      })
      const checkout = await unwrap(window.aio.tasks.save(extra))
      await unwrap(window.aio.tasks.save({
        ...made,
        kind: "monitor",
        monitorOnly: true,
        linkedCheckoutIds: [...(made.linkedCheckoutIds ?? []), checkout.id]
      }))
      setMessage(taskText(lang, "quickAdded"))
      setExtraAccountId("")
      await onCreated()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card form-grid" onSubmit={create}>
      <div className="span-2">
        <h2>{taskText(lang, "quickTitle")}</h2>
        <p className="hint">{taskText(lang, "quickHint")}</p>
      </div>
      {error ? <Banner tone="error">{error}</Banner> : null}
      {message ? <Banner tone="info">{message}</Banner> : null}
      {report?.issues.length ? report.issues.map((item) => (
        <Banner key={`${item.code}:${JSON.stringify(item.vars ?? {})}`} tone={item.level === "block" ? "error" : "info"}>{issueText(lang, item)}</Banner>
      )) : null}
      <Field label={clientText(lang, "filter")}>
        <Select value={clientId} disabled={Boolean(made)} onChange={(event) => chooseClient(event.target.value)} aria-label={clientText(lang, "filter")}>
          {clientOptions.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </Select>
      </Field>
      <Field label={taskText(lang, "store")}>
        <Select value={store} onChange={(event) => { setStore(event.target.value as StoreId); setAccountId("") }} aria-label={taskText(lang, "store")}>
          {stores.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </Select>
      </Field>
      <Field label={taskText(lang, "sku")} hint={selectedStore?.skuHint}>
        <TextInput value={sku} onChange={(event) => setSku(event.target.value)} placeholder={selectedStore?.skuHint} />
      </Field>
      <Field label={taskText(lang, "keywords")} hint={taskText(lang, "inherit")}>
        <TextInput value={keywords} onChange={(event) => setKeywords(event.target.value)} />
      </Field>
      <Field label={taskText(lang, "quantity")}>
        <TextInput type="number" min={1} max={12} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} required />
      </Field>
      <Field label={taskText(lang, "profile")}>
        <Select value={profileId} onChange={(event) => setProfileId(event.target.value)} aria-label={taskText(lang, "profile")}>
          <option value="">{taskText(lang, "profile")}</option>
          {clientProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.last4}</option>)}
        </Select>
      </Field>
      <Field label={taskText(lang, "proxy")}>
        <Select value={proxyGroupId} onChange={(event) => setProxyGroupId(event.target.value)} aria-label={taskText(lang, "proxy")}>
          <option value="">{taskText(lang, "direct")}</option>
          {openGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </Select>
      </Field>
      <div className="span-2 actions">
        <button type="button" aria-pressed={!newAccount} onClick={() => setNewAccount(false)}>{taskText(lang, "quickExisting")}</button>
        <button type="button" aria-pressed={newAccount} onClick={() => setNewAccount(true)}>{taskText(lang, "quickNewAccount")}</button>
      </div>
      {newAccount ? (
        <>
          <Field label={taskText(lang, "quickLabel")}>
            <TextInput value={label} onChange={(event) => setLabel(event.target.value)} required />
          </Field>
          <Field label={taskText(lang, "quickEmail")}>
            <TextInput type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </Field>
          <Field label={taskText(lang, "quickPassword")}>
            <TextInput type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </Field>
        </>
      ) : (
        <Field label={taskText(lang, "account")}>
          <Select value={accountId} onChange={(event) => setAccountId(event.target.value)} aria-label={taskText(lang, "account")}>
            <option value="">{taskText(lang, "account")}</option>
            {storeAccounts.map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
          </Select>
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={testMode} onChange={(event) => setTestMode(event.target.checked)} />
        <span>{taskText(lang, "quickTest")}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={confirmPurchase} onChange={(event) => setConfirmPurchase(event.target.checked)} disabled={testMode} />
        <span>{taskText(lang, "confirm")}</span>
      </label>
      <label className="check span-2">
        <input type="checkbox" checked={warm} onChange={(event) => setWarm(event.target.checked)} />
        <span>{taskText(lang, "quickWarm")}</span>
      </label>
      {!clientProfiles.length ? <p className="span-2 hint">{taskText(lang, "quickNeedProfile")} <a href="#profiles">{taskText(lang, "quickProfiles")}</a></p> : null}
      <div className="actions span-2">
        <button className="primary" type="submit" disabled={busy || !clientProfiles.length || blocked}>{taskText(lang, "quickCreate")}</button>
      </div>
      {made ? (
        <div className="span-2 actions">
          <span className="hint">{taskText(lang, "quickAnotherHint")}</span>
          <Select value={extraAccountId} onChange={(event) => setExtraAccountId(event.target.value)} aria-label={taskText(lang, "quickAnother")}>
            <option value="">{taskText(lang, "account")}</option>
            {accounts.filter((account) => account.store === made.store && clientIdOf(account.clientId) === clientIdOf(made.clientId)).map((account) => <option key={account.id} value={account.id}>{account.label}</option>)}
          </Select>
          <button type="button" onClick={() => void addAccount()} disabled={busy || !extraAccountId}>{taskText(lang, "quickAnother")}</button>
        </div>
      ) : null}
    </form>
  )
}
