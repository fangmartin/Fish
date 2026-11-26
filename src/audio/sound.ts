type Sound = 'drop' | 'eat' | 'level' | 'burp' | 'release'
let audio: AudioContext | undefined
let muted = false

export function setSoundMuted(value: boolean) {
  muted = value
}

export function unlockSound() {
  if (muted || typeof AudioContext === 'undefined') return
  try {
    audio ??= new AudioContext()
    if (audio.state === 'suspended') void audio.resume().catch(() => {})
  } catch {
    audio = undefined
  }
}

export function playSound(sound: Sound) {
  if (muted || !audio || audio.state !== 'running') return
  const patterns: Record<Sound, [number, number, number, number, OscillatorType][]> = {
    drop: [[490, 185, 0, 0.18, 'sine'], [760, 410, 0.045, 0.17, 'sine']],
    eat: [[370, 710, 0, 0.17, 'sine']],
    level: [[392, 392, 0, 0.43, 'sine'], [494, 494, 0.08, 0.42, 'sine'], [587, 587, 0.16, 0.53, 'sine']],
    burp: [[122, 66, 0, 0.36, 'triangle']],
    release: [[246, 85, 0, 0.35, 'sine'], [820, 460, 0.085, 0.27, 'sine']],
  }
  for (const [startPitch, endPitch, delay, duration, shape] of patterns[sound]) {
    const start = audio.currentTime + delay
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    oscillator.type = shape
    oscillator.frequency.setValueAtTime(startPitch, start)
    oscillator.frequency.exponentialRampToValueAtTime(endPitch, start + duration)
    gain.gain.setValueAtTime(0.001, start)
    gain.gain.exponentialRampToValueAtTime(0.1, start + 0.025)
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
    oscillator.connect(gain)
    gain.connect(audio.destination)
    oscillator.start(start)
    oscillator.stop(start + duration)
  }
}
