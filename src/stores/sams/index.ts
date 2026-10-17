import { SAMS } from "../page/parse"
import { createPageModule, pageChallengePause } from "../page/run"
import type { StoreModule } from "../module"

export const SAMS_PAUSE = pageChallengePause(SAMS.name)

export function createSamsModule(): StoreModule {
  return createPageModule(SAMS)
}
