import { createStubModule } from "../stub"
import type { StoreModule } from "../module"

export function createWalmartModule(): StoreModule {
  return createStubModule({
    id: "walmart",
    name: "Walmart",
    skuHint: "SKU or product URL",
    implemented: false
  })
}
