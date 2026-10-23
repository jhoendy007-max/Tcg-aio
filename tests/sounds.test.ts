import { describe, expect, it } from "vitest"
import { DEFAULT_EVENT_SOUND, SOUNDS, SOUND_IDS, soundEventFor } from "../src/shared/sounds"
import { cleanSettings } from "../src/engine/validate"
import { DEFAULT_SETTINGS } from "../src/shared/types"
import { existsSync } from "node:fs"

describe("sounds (0.2.40)", () => {
  it("maps task status changes to sound events; dry run plays success", () => {
    expect(soundEventFor("monitoring", "in_stock")).toBe("instock")
    expect(soundEventFor("checking_out", "success")).toBe("success")
    expect(soundEventFor("checking_out", "tested")).toBe("success")
    expect(soundEventFor("checking_out", "failed")).toBe("failure")
    expect(soundEventFor("idle", "monitoring")).toBeNull()
  })
  it("default sounds are distinct from each other and each sound has a distinct tone pattern", () => {
    expect(new Set(Object.values(DEFAULT_EVENT_SOUND)).size).toBe(3)
    expect(new Set(SOUND_IDS.map((id) => JSON.stringify(SOUNDS[id].tones))).size).toBe(SOUND_IDS.length)
  })
  it("every sound has a generated phone WAV", () => {
    for (const id of SOUND_IDS) expect(existsSync(`mobile/assets/sounds/zzz_${id}.wav`), id).toBe(true)
  })
  it("validates sound settings", () => {
    const out = cleanSettings({ ...DEFAULT_SETTINGS, soundVolume: 400, soundInStock: "nope", soundFailure: "off" })
    expect(out.soundVolume).toBe(100)
    expect(out.soundInStock).toBe("rise")
    expect(out.soundFailure).toBe("off")
  })
})
