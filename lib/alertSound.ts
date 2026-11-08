// Short synthesized chimes for agent alerts. Generated with Web Audio rather than
// shipped as files: there's nothing to license, load or fail to find.

export type AlertKind = 'done' | 'blocked'

const NOTES: Record<AlertKind, { freq: number; at: number }[]> = {
  done: [{ freq: 659, at: 0 }, { freq: 880, at: 0.11 }],
  blocked: [{ freq: 880, at: 0 }, { freq: 659, at: 0.13 }, { freq: 880, at: 0.26 }],
}

const NOTE_LENGTH = 0.22
const VOLUME = 0.07

let ctx: AudioContext | null = null

export function playAlert(kind: AlertKind): void {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const start = ctx.currentTime
    for (const { freq, at } of NOTES[kind]) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, start + at)
      gain.gain.exponentialRampToValueAtTime(VOLUME, start + at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + at + NOTE_LENGTH)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start + at)
      osc.stop(start + at + NOTE_LENGTH)
    }
  } catch {
    // No audio device or no AudioContext: the toast still carries the alert.
  }
}
