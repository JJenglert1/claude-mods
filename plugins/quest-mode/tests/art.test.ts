import { describe, expect, test } from 'claude-code/testing'

import {
  BOSS,
  BOSS_BEATEN,
  CASTLE,
  CASTLE_BEATEN,
  PINE,
  drawArena,
  drawBanner,
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
})

describe('layout', () => {

})

describe('rendering', () => {

  test('terminal cells: half blocks, three u32 per cell, packed as base64', () => {
    const px = drawScene(scene(['current', 'todo', 'todo'], 30))
    const { columns, rows, cells } = toCells(px)
    expect(columns).toBe(30)
    expect(rows).toBe(12)
    // 30 * 9 cells * 12 bytes, padded base64
    expect(cells).toHaveLength(Math.ceil((30 * 12 * 12) / 3) * 4)
    expect(cells).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    // first cell: code point U+2580 little-endian is 80 25 00 00
    expect(cells.startsWith(toBase64([0x80, 0x25, 0, 0]).slice(0, 4))).toBe(true)
  })

  test('svg: valid markup, crisp, well under the size limit', () => {
    const svg = toSvg(drawScene(scene(['done', 'done', 'current', 'todo', 'todo', 'todo'], 64)), 6)
    expect(svg.startsWith('<svg ')).toBe(true)
    expect(svg.endsWith('</svg>')).toBe(true)
    expect(svg).toContain('viewBox="0 0 64 24"')
    expect(svg).toContain('width="384"')
    expect(svg).toContain('crispEdges')
    expect(svg.length).toBeLessThan(40_000)
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('undefined')
  })

})

describe('arena and banner', () => {

})

describe('sound', () => {
})
