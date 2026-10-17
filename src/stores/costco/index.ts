import { COSTCO } from "../page/parse"
import { createPageModule, pageChallengePause } from "../page/run"
import type { StoreModule } from "../module"

export const COSTCO_PAUSE = pageChallengePause(COSTCO.name)

export function createCostcoModule(): StoreModule {
  return createPageModule(COSTCO)
}
