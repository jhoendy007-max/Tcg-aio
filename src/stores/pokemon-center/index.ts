import { createStubModule } from "../stub"
import type { StoreModule } from "../module"

export function createPokemonCenterModule(): StoreModule {
  return createStubModule({
    id: "pokemon-center",
    name: "Pokémon Center",
    skuHint: "Product URL",
    implemented: false
  })
}
