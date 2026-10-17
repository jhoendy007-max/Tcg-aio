import { BARNES_NOBLE } from "../page/parse"
import { createPageModule, pageChallengePause } from "../page/run"
import type { StoreModule } from "../module"

export const BARNES_PAUSE = pageChallengePause(BARNES_NOBLE.name)

export function createBarnesNobleModule(): StoreModule {
  return createPageModule(BARNES_NOBLE)
}
