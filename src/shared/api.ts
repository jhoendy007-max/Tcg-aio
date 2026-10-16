import { channels } from "./ipc"
import type {
  AccountInput,
  ProxyGroup,
  ProxyGroupInput,
  ProxyTestResult,
  PublicAccount,
  PublicProfile,
  PublicTask,
  Result,
  Settings,
  SettingsPayload,
  StoreInfo,
  TaskEvent,
  TaskInput,
  ProfileInput,
  StoreHealth
} from "./types"
import type { PhoneInvite, PhoneStatus } from "../phone/protocol"

export interface AioApi {
  tasks: {
    list: () => Promise<Result<PublicTask[]>>
    save: (input: TaskInput) => Promise<Result<PublicTask>>
    delete: (id: string) => Promise<Result<{ id: string }>>
    start: (id: string) => Promise<Result<{ started: true }>>
    test: (id: string) => Promise<Result<{ started: true }>>
    stop: (id: string) => Promise<Result<{ stopped: true }>>
    onEvent: (cb: (event: TaskEvent) => void) => () => void
  }
  health: {
    check: (proxyGroupId: string | null) => Promise<Result<StoreHealth[]>>
  }
  profiles: {
    list: () => Promise<Result<PublicProfile[]>>
    save: (input: ProfileInput) => Promise<Result<PublicProfile>>
    delete: (id: string) => Promise<Result<{ id: string }>>
  }
  proxies: {
    list: () => Promise<Result<ProxyGroup[]>>
    save: (input: ProxyGroupInput) => Promise<Result<ProxyGroup>>
    delete: (id: string) => Promise<Result<{ id: string }>>
    test: (id: string) => Promise<Result<ProxyTestResult[]>>
  }
  accounts: {
    list: () => Promise<Result<PublicAccount[]>>
    save: (input: AccountInput) => Promise<Result<PublicAccount>>
    delete: (id: string) => Promise<Result<{ id: string }>>
  }
  settings: {
    get: () => Promise<Result<SettingsPayload>>
    save: (input: Settings) => Promise<Result<SettingsPayload>>
    testWebhook: () => Promise<Result<{ delivered: true }>>
  }
  stores: {
    list: () => Promise<Result<StoreInfo[]>>
  }
  phone: {
    status: () => Promise<Result<PhoneStatus>>
    invite: () => Promise<Result<PhoneInvite>>
    revoke: (id: string) => Promise<Result<PhoneStatus>>
    saveRelay: (url: string) => Promise<Result<PhoneStatus>>
    onEvent: (cb: (status: PhoneStatus) => void) => () => void
  }
}

export const aioChannels = channels
