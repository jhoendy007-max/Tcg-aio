import { STORE_CATALOG } from "../shared/stores"
import type { StoreId, StoreInfo } from "../shared/types"
import type { StoreModule } from "./module"
import { createStubModule } from "./stub"
import { createTargetModule } from "./target"
import { createWalmartModule } from "./walmart"
import { createBestBuyModule } from "./bestbuy"
import { createPokemonCenterModule } from "./pokemon-center"
import { createAmazonModule } from "./amazon"
import { createCrunchyrollModule } from "./crunchyroll"
import { createBandaiModule } from "./bandai"

export function createRegistry(): Map<StoreId, StoreModule> {
  const modules = new Map<StoreId, StoreModule>()
  for (const info of STORE_CATALOG) modules.set(info.id, createStubModule(info))
  modules.set("target", createTargetModule())
  modules.set("walmart", createWalmartModule())
  modules.set("bestbuy", createBestBuyModule())
  modules.set("pokemon-center", createPokemonCenterModule())
  modules.set("amazon", createAmazonModule())
  modules.set("crunchyroll", createCrunchyrollModule())
  modules.set("bandai", createBandaiModule())
  return modules
}

export function listStores(registry: Map<StoreId, StoreModule>): StoreInfo[] {
  return [...registry.values()].map((module) => ({
    id: module.id,
    name: module.displayName,
    skuHint: module.skuHint,
    implemented: module.implemented
  }))
}
