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
