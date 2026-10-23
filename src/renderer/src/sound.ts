import { SOUNDS, type SoundEvent, type SoundId, isSoundId } from "../../shared/sounds"
let lastPlayed = 0

export function playSuccessChime(): void {
  const now = Date.now()
  if (now - lastPlayed < 1200) return
  lastPlayed = now
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return
  const audio = new Ctx()
  const osc = audio.createOscillator()
  const gain = audio.createGain()
  osc.type = "sine"
  osc.frequency.setValueAtTime(523, audio.currentTime)
  osc.frequency.setValueAtTime(784, audio.currentTime + 0.12)
  gain.gain.setValueAtTime(0.0001, audio.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.08, audio.currentTime + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.45)
  osc.connect(gain)
  gain.connect(audio.destination)
  osc.start()
  osc.stop(audio.currentTime + 0.48)
  osc.onended = () => void audio.close()
}


let lastEventSound = 0

/** 0.2.40: play one of the generated alert sounds at a 0–100 volume. */
export function playSound(id: SoundId, volume = 70): void {
  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctx) return
  const audio = new Ctx()
  const level = Math.max(0.0001, Math.min(1, volume / 100) * 0.25)
  let end = 0
  for (const tone of SOUNDS[id].tones) {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = tone.wave
    osc.frequency.setValueAtTime(tone.freq, audio.currentTime + tone.start)
    gain.gain.setValueAtTime(0.0001, audio.currentTime + tone.start)
    gain.gain.exponentialRampToValueAtTime(level, audio.currentTime + tone.start + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + tone.start + tone.dur)
    osc.connect(gain)
    gain.connect(audio.destination)
    osc.start(audio.currentTime + tone.start)
    osc.stop(audio.currentTime + tone.start + tone.dur + 0.02)
    end = Math.max(end, tone.start + tone.dur)
  }
  setTimeout(() => void audio.close(), (end + 0.2) * 1000)
}

/** Event sound from Settings. Throttled so a burst of tasks does not stack sounds. */
export function playEventSound(settings: { soundsOn?: boolean; soundVolume?: number; soundInStock?: string; soundSuccess?: string; soundFailure?: string }, event: SoundEvent): void {
  if (settings.soundsOn === false) return
  const choice = event === "instock" ? settings.soundInStock : event === "success" ? settings.soundSuccess : settings.soundFailure
  if (!isSoundId(choice)) return
  const now = Date.now()
  if (now - lastEventSound < 700) return
  lastEventSound = now
  playSound(choice, settings.soundVolume ?? 70)
}
