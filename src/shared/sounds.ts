/**
 * 0.2.40 alert sounds. Every sound is generated from these note lists (WebAudio on the PC,
 * pre-rendered WAVs for Android in mobile/assets/sounds). No recorded or third-party audio.
 */
export type SoundId = "chime" | "bell" | "pulse" | "rise" | "fanfare" | "drop" | "buzz" | "knock"
export type SoundEvent = "instock" | "success" | "failure"

export interface Tone { freq: number; start: number; dur: number; wave: "sine" | "triangle" | "square" | "sawtooth" }

export const SOUNDS: Record<SoundId, { label: string; tones: Tone[] }> = {
  chime: { label: "Chime", tones: [{ freq: 880, start: 0, dur: 0.18, wave: "sine" }, { freq: 1318.5, start: 0.14, dur: 0.32, wave: "sine" }] },
  bell: { label: "Bell", tones: [{ freq: 1046.5, start: 0, dur: 0.6, wave: "triangle" }, { freq: 2093, start: 0, dur: 0.35, wave: "sine" }] },
  pulse: { label: "Pulse", tones: [{ freq: 740, start: 0, dur: 0.09, wave: "square" }, { freq: 740, start: 0.16, dur: 0.09, wave: "square" }, { freq: 740, start: 0.32, dur: 0.09, wave: "square" }] },
  rise: { label: "Rise", tones: [{ freq: 523.3, start: 0, dur: 0.12, wave: "sine" }, { freq: 659.3, start: 0.1, dur: 0.12, wave: "sine" }, { freq: 784, start: 0.2, dur: 0.12, wave: "sine" }, { freq: 1046.5, start: 0.3, dur: 0.3, wave: "sine" }] },
  fanfare: { label: "Fanfare", tones: [{ freq: 784, start: 0, dur: 0.14, wave: "triangle" }, { freq: 784, start: 0.16, dur: 0.14, wave: "triangle" }, { freq: 1046.5, start: 0.32, dur: 0.45, wave: "triangle" }] },
  drop: { label: "Drop", tones: [{ freq: 659.3, start: 0, dur: 0.16, wave: "sine" }, { freq: 440, start: 0.15, dur: 0.16, wave: "sine" }, { freq: 293.7, start: 0.3, dur: 0.35, wave: "sine" }] },
  buzz: { label: "Buzz", tones: [{ freq: 196, start: 0, dur: 0.22, wave: "sawtooth" }, { freq: 185, start: 0.26, dur: 0.3, wave: "sawtooth" }] },
  knock: { label: "Knock", tones: [{ freq: 220, start: 0, dur: 0.07, wave: "triangle" }, { freq: 220, start: 0.12, dur: 0.07, wave: "triangle" }] }
}

/** The challenge alert keeps its own sound (Android channel default + vibration) and is never one of these. */
export const DEFAULT_EVENT_SOUND: Record<SoundEvent, SoundId> = { instock: "rise", success: "fanfare", failure: "drop" }

export const SOUND_EVENT_LABEL: Record<SoundEvent, string> = { instock: "Monitor in stock", success: "Checkout success", failure: "Checkout failed / declined" }

export function isSoundId(value: unknown): value is SoundId {
  return typeof value === "string" && value in SOUNDS
}

/** Which event sound (if any) a task status change should play. Dry runs play the success sound (logged as DRY RUN). */
export function soundEventFor(before: string | undefined, after: string): SoundEvent | null {
  if (before === after) return null
  if (after === "in_stock") return "instock"
  if (after === "success" || after === "tested") return "success"
  if (after === "failed") return "failure"
  return null
}
export const SOUND_IDS = Object.keys(SOUNDS) as SoundId[]
