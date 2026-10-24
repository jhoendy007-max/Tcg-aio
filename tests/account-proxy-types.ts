export type { ProxyEndpoint, ProxyGroup } from "../src/shared/types"
export interface StickyPinLike {
  accountId: string
  groupId: string
  proxyId: string
  exclusive?: boolean
}
