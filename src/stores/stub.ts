import type { StoreInfo } from "../shared/types"
import type { StoreModule } from "./module"

export function createStubModule(info: StoreInfo): StoreModule {
  return {
    id: info.id,
    displayName: info.name,
    skuHint: info.skuHint,
    implemented: false,
    async run(ctx) {
      const reason = `${info.name} is registered as a store module, but monitor and checkout are not implemented in v1.`
      ctx.log("warn", reason)
      ctx.detail(reason)
      return { outcome: "failed", reason }
    }
  }
}
