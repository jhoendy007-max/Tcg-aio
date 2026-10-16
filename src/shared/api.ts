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
  ProfileInput
} from "./types"

export interface AioApi {
  tasks: {
    list: () => Promise<Result<PublicTask[]>>
    save: (input: TaskInput) => Promise<Result<PublicTask>>
    delete: (id: string) => Promise<Result<{ id: string }>>
    start: (id: string) => Promise<Result<{ started: true }>>
    stop: (id: string) => Promise<Result<{ stopped: true }>>
    onEvent: (cb: (event: TaskEvent) => void) => () => void
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
}

export const aioChannels = channels
