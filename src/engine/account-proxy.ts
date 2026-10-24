import type { ProxyEndpoint, ProxyGroup } from "../shared/types"
import { proxyLabel } from "../shared/proxy"

/**
 * One rule for which proxy an account's browser profile uses. The task runner's HTTP path,
 * the sign-in window, the warm-up window, Save cookies and the keep-warm window all ask this
 * module, so a task and the browser profile that belongs to it never end up on different proxies.
 *
 * Rule (same as the task runner has always used): the account's own proxy group wins, otherwise
 * the group of the task that is asking. Within a group the account is pinned to one proxy and
 * stays on it (sticky, never rotated mid-session).
 */
export interface ProxyAccountRef {
  id: string
  proxyGroupId?: string | null
}

export interface ProxyTaskRef {
  id: string
  accountId: string
  proxyGroupId: string | null
  kind?: string
  monitorOnly?: boolean
}

export type BrowserProxyStatus = "bound" | "pending" | "direct" | "direct-warning" | "conflict"

export interface AccountProxyPlan {
  groupId: string | null
  source: "account" | "task" | "none"
  /** Different proxy groups on this account's tasks, when the account has none of its own. */
  conflictGroupIds: string[]
  /** The asking task has its own group but the account's group wins. */
  overriddenTaskGroupId: string | null
}

/** Pure: which proxy group does this account's browser profile belong to? */
export function planAccountProxy(account: ProxyAccountRef, tasks: ProxyTaskRef[], preferTaskId?: string): AccountProxyPlan {
  const own = tasks.filter((task) => task.accountId === account.id && task.kind !== "monitor" && task.monitorOnly !== true)
  const groups = [...new Set(own.map((task) => task.proxyGroupId).filter((id): id is string => Boolean(id)))]
  const preferred = preferTaskId ? own.find((task) => task.id === preferTaskId) : undefined
  if (account.proxyGroupId) {
    const other = (preferred ? [preferred.proxyGroupId] : groups).find((id) => id && id !== account.proxyGroupId) ?? null
    return { groupId: account.proxyGroupId, source: "account", conflictGroupIds: [], overriddenTaskGroupId: other }
  }
  // A named task decides for itself. A task with no proxy runs direct and so does its browser.
  if (preferred) return { groupId: preferred.proxyGroupId, source: preferred.proxyGroupId ? "task" : "none", conflictGroupIds: [], overriddenTaskGroupId: null }
  if (groups.length === 0) return { groupId: null, source: "none", conflictGroupIds: [], overriddenTaskGroupId: null }
  return { groupId: groups[0], source: "task", conflictGroupIds: groups.length > 1 ? groups : [], overriddenTaskGroupId: null }
}

export interface ProxyChoiceLike {
  proxy?: ProxyEndpoint
  stickyOutside?: boolean
  heldProxyId?: string
  allBenched?: boolean
}

export interface ProxyResolverDb {
  listTasks(): ProxyTaskRef[]
  readAccount(id: string): ProxyAccountRef
  getProxyGroup(id: string): ProxyGroup
  assignProxy(accountId: string, groupId: string, proxies: ProxyEndpoint[]): ProxyChoiceLike
  findProxy(id: string): ProxyEndpoint | undefined
}

export interface AccountProxyResolution {
  proxy?: ProxyEndpoint
  groupId: string | null
  groupName: string | null
  source: AccountProxyPlan["source"]
  /** A task of this account has a proxy group, yet no proxy could be chosen. A window must not run direct. */
  directWithGroup: boolean
  /** Plain-words notes. They never contain a username or password. */
  notes: string[]
}

/** The single resolver every browser window and the HTTP path use. It pins the account to one proxy. */
export function proxyForAccountTask(db: ProxyResolverDb, accountId: string, taskId?: string): AccountProxyResolution {
  const account = db.readAccount(accountId)
  const plan = planAccountProxy(account, db.listTasks(), taskId)
  const notes: string[] = []
  if (plan.overriddenTaskGroupId) notes.push("A task's proxy group does not override the account's sticky proxy.")
  if (plan.conflictGroupIds.length > 1) notes.push("This account's tasks use different proxy groups. The first one is used for the browser profile.")
  if (!plan.groupId) return { groupId: null, groupName: null, source: plan.source, directWithGroup: false, notes }
  let group: ProxyGroup
  try {
    group = db.getProxyGroup(plan.groupId)
  } catch {
    notes.push("The proxy group for this account no longer exists.")
    return { groupId: plan.groupId, groupName: null, source: plan.source, directWithGroup: true, notes }
  }
  const choice = db.assignProxy(accountId, group.id, group.proxies)
  if (choice.stickyOutside && choice.heldProxyId) {
    const held = db.findProxy(choice.heldProxyId)
    notes.push("The selected proxy group does not include this account's sticky proxy. Keeping the sticky proxy.")
    return { proxy: held, groupId: group.id, groupName: group.name, source: plan.source, directWithGroup: !held, notes }
  }
  if (!choice.proxy) notes.push(`No free proxy is left in ${group.name}.`)
  return { proxy: choice.proxy, groupId: group.id, groupName: group.name, source: plan.source, directWithGroup: !choice.proxy, notes }
}

export interface BrowserProxyView {
  status: BrowserProxyStatus
  /** host:port only. Never a username or password. */
  label: string | null
  groupName: string | null
  source: AccountProxyPlan["source"]
  note: string
}

/** Pure, no side effects: what the Accounts page shows for one browser profile. */
export function browserProxyView(
  account: ProxyAccountRef,
  tasks: ProxyTaskRef[],
  groups: ProxyGroup[],
  pinProxyId: string | null | undefined
): BrowserProxyView {
  const plan = planAccountProxy(account, tasks)
  if (!plan.groupId) {
    return { status: "direct", label: null, groupName: null, source: "none", note: "Direct. No task or account proxy." }
  }
  const group = groups.find((item) => item.id === plan.groupId)
  if (!group || group.proxies.length === 0) {
    return {
      status: "direct-warning",
      label: null,
      groupName: group?.name ?? null,
      source: plan.source,
      note: "Its proxy group is missing or empty. The browser would run direct, so Zzz AIO will not open it."
    }
  }
  const all = groups.flatMap((item) => item.proxies)
  const pinned = pinProxyId ? all.find((proxy) => proxy.id === pinProxyId) : undefined
  const base: Omit<BrowserProxyView, "status" | "label" | "note"> = { groupName: group.name, source: plan.source }
  if (plan.conflictGroupIds.length > 1) {
    return {
      ...base,
      status: "conflict",
      label: pinned ? proxyLabel(pinned) : null,
      note: "Tasks on this account use different proxy groups. The browser follows the first one. Give the account one proxy group to remove the conflict."
    }
  }
  if (!pinned) return { ...base, status: "pending", label: null, note: "Binds to one proxy from this group the first time a task or window uses it." }
  return {
    ...base,
    status: "bound",
    label: proxyLabel(pinned),
    note: plan.overriddenTaskGroupId ? "Sticky. A task proxy group differs, but the account's proxy wins." : "Sticky. The same proxy every run."
  }
}
