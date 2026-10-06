// Short tones for milestones, built as tiny WAV files in memory. Sound is off
// by default; nothing here runs unless the person turned it on.
import { toBase64 } from './art'

export type Tone = 'step' | 'win' | 'hit' | 'miss' | 'boss'

type Note = readonly [freq: number, ms: number]

const NOTES: Record<Tone, readonly Note[]> = {
  step: [
    [523, 90],
    [659, 140],
  ],
  win: [
    [523, 100],
    [659, 100],
    [784, 100],
    [1047, 280],
  ],
  hit: [
    [196, 110],
    [147, 150],
  ],
  miss: [[220, 220]],
  boss: [
    [147, 150],
    [110, 260],
  ],
}

const RATE = 8000

/** 8-bit mono PCM WAV, as a byte list. */
export function wavBytes(notes: readonly Note[]): number[] {
  const samples: number[] = []
  for (const [freq, ms] of notes) {
    const count = Math.round((RATE * ms) / 1000)
    for (let i = 0; i < count; i += 1) {
      const fade = Math.min(1, i / 80, (count - i) / 80)
      samples.push(128 + Math.round(Math.sin((2 * Math.PI * freq * i) / RATE) * fade * 60))
    }
  }
  const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
  const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
  const text = (s: string) => Array.from(s, c => c.charCodeAt(0))
  return [
    ...text('RIFF'),
    ...le32(36 + samples.length),
    ...text('WAVE'),
    ...text('fmt '),
    ...le32(16),
    ...le16(1), // PCM
    ...le16(1), // mono
    ...le32(RATE),
    ...le32(RATE), // byte rate: one byte per sample
    ...le16(1),
    ...le16(8),
    ...text('data'),
    ...le32(samples.length),
    ...samples,
  ]
}

const cache = new Map<Tone, string>()

/** The tone as a base64 WAV, built once. */
export function toneBase64(tone: Tone): string {
  let value = cache.get(tone)
  if (value === undefined) {
    value = toBase64(wavBytes(NOTES[tone]))
    cache.set(tone, value)
  }
  return value
}
