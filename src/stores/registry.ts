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
import { createGameStopModule } from "./gamestop"
import { createBarnesNobleModule } from "./barnes-noble"
import { createCostcoModule } from "./costco"
import { createSamsModule } from "./sams"
import { createTcgplayerModule } from "./tcgplayer"

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
  modules.set("gamestop", createGameStopModule())
  modules.set("barnes-noble", createBarnesNobleModule())
  modules.set("costco", createCostcoModule())
  modules.set("sams", createSamsModule())
  modules.set("tcgplayer", createTcgplayerModule())
  return modules
}

export function moduleAddressCaps(modules: Iterable<StoreModule>): Partial<Record<StoreId, number>> {
  const caps: Partial<Record<StoreId, number>> = {}
  for (const module of modules) {
    const cap = module.addressOrderCap
    if (typeof cap === "number" && Number.isFinite(cap) && cap >= 1 && cap < 3) caps[module.id] = Math.round(cap)
  }
  return caps
}

export function listStores(registry: Map<StoreId, StoreModule>): StoreInfo[] {
  return [...registry.values()].map((module) => ({
    id: module.id,
    name: module.displayName,
    skuHint: module.skuHint,
    implemented: module.implemented
  }))
}
