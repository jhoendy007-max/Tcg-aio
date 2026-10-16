import { createStubModule } from "../stub"
import type { StoreModule } from "../module"

export function createBestBuyModule(): StoreModule {
  return createStubModule({
    id: "bestbuy",
    name: "Best Buy",
    skuHint: "SKU or product URL",
    implemented: false
  })
}
