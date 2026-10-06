import { describe, expect, test } from 'claude-code/testing'

import {
  BOSS,
  BOSS_BEATEN,
  HERO,
  HERO_STEP,
  MARK_DONE,
  MARK_NOW,
  MARK_TODO,
  SCENE_H,
  drawScene,
  fitsMap,
  heroPosition,
  heroSpot,
  mapAlt,
  stopXs,
  textMap,
  toBase64,
  toCells,
  toSvg,
  walkT,
} from '../hooks/art'
import type { Scene } from '../hooks/art'
import { toneBase64, wavBytes } from '../hooks/sound'

const scene = (states: ('done' | 'current' | 'todo')[], width = 60, hero?: Scene['hero'], celebrate = false): Scene => {
  const stops = states.map((state, i) => ({ boss: i === states.length - 1, state }))
  const at = Math.max(0, states.findIndex(s => s === 'current'))
  return { width, stops, hero: hero ?? { at, to: at, t: 0, step: 0 }, celebrate }
}

describe('sprites are small data tables', () => {
  test('every sprite is a clean rectangle of known colors', () => {
    const sets: [string[], number, number][] = [
      [HERO, 5, 7],
      [HERO_STEP, 5, 7],
      [MARK_TODO, 5, 5],
      [MARK_DONE, 5, 5],
      [MARK_NOW, 5, 5],
      [BOSS, 7, 7],
      [BOSS_BEATEN, 7, 7],
    ]
    for (const [sprite, w, h] of sets) {
      expect(sprite).toHaveLength(h)
      for (const row of sprite) {
        expect(row).toHaveLength(w)
        expect(row).toMatch(/^[.a-zA-Z]+$/)
      }
    }
  })
})

describe('layout', () => {
  test('stops spread evenly with room at both ends', () => {
    const xs = stopXs(60, 5)
    expect(xs[0]).toBe(7)
    expect(xs[4]).toBe(53)
    expect(xs.every((x, i) => i === 0 || x > (xs[i - 1] as number))).toBe(true)
  })

  test('the map fits only when stops are far enough apart', () => {
    expect(fitsMap(64, 8)).toBe(true)
    expect(fitsMap(40, 8)).toBe(false)
    expect(fitsMap(26, 3)).toBe(true)
    expect(fitsMap(24, 3)).toBe(false)
  })

  test('the hero stands above a stop, beside a live boss and on a beaten one', () => {
    const live = scene(['done', 'done', 'current'])
    expect(heroSpot(live, 1)).toEqual({ x: stopXs(60, 3)[1], y: 2 })
    expect(heroSpot(live, 2).x).toBe((stopXs(60, 3)[2] as number) - 8)
    const won = scene(['done', 'done', 'done'])
    expect(heroSpot(won, 2)).toEqual({ x: stopXs(60, 3)[2], y: 1 })
  })

  test('walking slides the hero between stops and stops at the end', () => {
    const states: ('done' | 'current' | 'todo')[] = ['done', 'current', 'todo', 'todo']
    const xs = stopXs(60, 4)
    const at = (t: number, step: number) => heroPosition(scene(states, 60, { at: 0, to: 1, t, step }))
    expect(at(0, 0).x).toBe(xs[0])
    expect(at(0.5, 1).x).toBe(Math.round(((xs[0] as number) + (xs[1] as number)) / 2))
    expect(at(1, 8)).toMatchObject({ x: xs[1], frame: 0 })
    expect(at(0.5, 1).frame).toBe(1)
    expect(walkT(4, 8)).toBe(0.5)
    expect(walkT(99, 8)).toBe(1)
  })
})

describe('rendering', () => {
  test('a scene is opaque and as tall as promised', () => {
    const px = drawScene(scene(['done', 'current', 'todo', 'todo']))
    expect(px.h).toBe(SCENE_H)
    expect(px.w).toBe(60)
    expect(px.data).toHaveLength(60 * SCENE_H)
    expect(px.data.every(c => c >= 0)).toBe(true)
  })

  test('terminal cells: half blocks, three u32 per cell, packed as base64', () => {
    const px = drawScene(scene(['current', 'todo', 'todo'], 30))
    const { columns, rows, cells } = toCells(px)
    expect(columns).toBe(30)
    expect(rows).toBe(9)
    // 30 * 9 cells * 12 bytes, padded base64
    expect(cells).toHaveLength(Math.ceil((30 * 9 * 12) / 3) * 4)
    expect(cells).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    // first cell: code point U+2580 little-endian is 80 25 00 00
    expect(cells.startsWith(toBase64([0x80, 0x25, 0, 0]).slice(0, 4))).toBe(true)
  })

  test('base64 matches the standard test vectors', () => {
    expect(toBase64([])).toBe('')
    expect(toBase64([0x4d])).toBe('TQ==')
    expect(toBase64([0x4d, 0x61])).toBe('TWE=')
    expect(toBase64([0x4d, 0x61, 0x6e])).toBe('TWFu')
    expect(toBase64(Array.from('hello world', c => c.charCodeAt(0)))).toBe('aGVsbG8gd29ybGQ=')
  })

  test('svg: valid markup, crisp, well under the size limit', () => {
    const svg = toSvg(drawScene(scene(['done', 'done', 'current', 'todo', 'todo', 'todo'], 64)), 6)
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('viewBox="0 0 64 18"')
    expect(svg).toContain('width="384"')
    expect(svg).toContain('crispEdges')
    expect(svg.length).toBeLessThan(40_000)
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('undefined')
  })

  test('victory adds confetti', () => {
    const plain = drawScene(scene(['done', 'done', 'done'], 40)).data
    const party = drawScene(scene(['done', 'done', 'done'], 40, undefined, true)).data
    expect(party.some((c, i) => c !== plain[i])).toBe(true)
  })

  test('text map and alt text', () => {
    const stops = scene(['done', 'current', 'todo', 'todo']).stops
    expect(textMap(stops)).toBe('✔ ─ ▶ ─ ○ ─ ☠')
    expect(mapAlt(stops, 1)).toContain('4 stops')
    expect(mapAlt(stops, 1)).toContain('stop 2')
  })
})

describe('sound', () => {
  test('tones are real WAV files', () => {
    const bytes = wavBytes([[440, 100]])
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE')
    expect(bytes.length).toBe(44 + 800)
    expect(toneBase64('win').startsWith('UklGR')).toBe(true) // "RIFF" in base64
    expect(toneBase64('win')).toBe(toneBase64('win'))
  })
})
