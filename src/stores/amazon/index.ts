import { createStubModule } from "../stub"
import type { StoreModule } from "../module"

export function createAmazonModule(): StoreModule {
  return createStubModule({
    id: "amazon",
    name: "Amazon",
    skuHint: "ASIN or product URL",
    implemented: false
  })
}
