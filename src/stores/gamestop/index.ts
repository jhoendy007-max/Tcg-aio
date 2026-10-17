import { GAMESTOP } from "../page/parse"
import { createPageModule, pageChallengePause } from "../page/run"
import type { StoreModule } from "../module"

export const GAMESTOP_PAUSE = pageChallengePause(GAMESTOP.name)

export function createGameStopModule(): StoreModule {
  return createPageModule(GAMESTOP)
}
