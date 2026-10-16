import { createStubModule } from "../stub"
import type { StoreModule } from "../module"

export function createCrunchyrollModule(): StoreModule {
  return createStubModule({
    id: "crunchyroll",
    name: "Crunchyroll",
    skuHint: "Product URL",
    implemented: false
  })
}
