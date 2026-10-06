// The pixel art, as small data tables, and the code that turns a scene into
// terminal cells (for Raster) or SVG markup (for the other surfaces).
// One scene, two renderers: what you see is the same on both.
import type { Quest, QuestWalk } from '../types'

/** Colors are 0xRRGGBB; -1 is transparent. Row-major. */
export type Pixels = { w: number; h: number; data: number[] }

export const SCENE_H = 24
export const MARGIN = 9
export const MIN_SPACING = 6

const PAL: Record<string, number> = {
  k: 0x1a1c2c, // dark
  c: 0xb13e53, // cap red
  s: 0xf4c9a0, // skin
  e: 0x1a1c2c, // eyes
  b: 0x3b5dc9, // tunic
  w: 0xf4f4f4, // white
  p: 0x5d275d, // boots
  g: 0x94b0c2, // stone grey
  G: 0x38b764, // green
  Y: 0xffcd75, // gold
  O: 0xef7d57, // orange
  R: 0xb13e53, // red
  W: 0xf4f4f4,
  K: 0x1a1c2c,
  T: 0x8b5a2b, // trunk
  f: 0x257179, // pine green
}

// ---- sprites: one string per row, '.' is empty -------------------------------

export const HERO = ['.ccc.', 'ccccc', 'seses', '.sss.', 'wbbbw', '.bbb.', '.p.p.']
export const HERO_STEP = ['.ccc.', 'ccccc', 'seses', '.sss.', 'wbbbw', '.bbb.', 'p...p']

export const MARK_TODO = ['.ggg.', 'g...g', 'g...g', 'g...g', '.ggg.']
export const MARK_DONE = ['.GGG.', 'GGGGW', 'WGGWG', 'GWWGG', '.GGG.']
export const MARK_NOW = ['..Y..', '.YOY.', 'YOOOY', '.YOY.', '..Y..']

/** The boss's lair at the end of the road: a castle with glowing red eyes. */
export const CASTLE = [
  'g.g..g..g.g',
  'ggg.ggg.ggg',
  'ggggggggggg',
  'gkggRgRggkg',
  'ggggggggggg',
  'ggggkkkgggg',
  'gkggkkkggkg',
  'ggggkkkgggg',
  'ggggkkkgggg',
  'ggggkkkgggg',
  'ggggkkkgggg',
  'ggggggggggg',
]
export const CASTLE_BEATEN = CASTLE.map(row => row.replace(/R/g, 'Y'))
export const PINE = ['.f.', 'fff', '.f.', 'fff', '.T.']

export const BOSS = ['R.....R', 'RRRRRRR', 'RWKRKWR', 'RRRRRRR', 'RWWWWWR', 'RWKWKWR', '.RRRRR.']
/** A beaten boss: the same shape in stone grey. */
export const BOSS_BEATEN = BOSS.map(row => row.replace(/R/g, 'g'))

const SKY = [0x1a1c2c, 0x29366f, 0x3b5dc9]
const GROUND = [0x38b764, 0x257179, 0x257179, 0x1a1c2c, 0x1a1c2c]
const PATH_DONE = 0xffcd75
const PATH_TODO = 0x566c86
const GRASS_TUFT = 0xa7f070

// ---- scenes --------------------------------------------------------------------

export type StopState = 'done' | 'current' | 'todo'
export type SceneStop = { boss: boolean; state: StopState }

export type Scene = {
  width: number
  /** The last stop is the boss. */
  stops: SceneStop[]
  /** Where the hero is: a stop index, or between two while walking. */
  hero: { at: number; to: number; t: number; step: number }
  /** Confetti: the quest is won. */
  celebrate: boolean
}

/** The x of the middle of each stop. */
export function stopXs(width: number, count: number): number[] {
  if (count <= 1) return [Math.round(width / 2)]
  const span = width - 2 * MARGIN
  return Array.from({ length: count }, (_, i) => MARGIN + Math.round((i * span) / (count - 1)))
}

/** True when the map's stops are far enough apart to draw as art. */
export function fitsMap(width: number, count: number): boolean {
  return count <= 1 || (width - 2 * MARGIN) / (count - 1) >= MIN_SPACING
}

type Spot = { x: number; y: number }

/** Where the hero's feet-centre sits at a stop: above a normal stop, beside the boss, on the boss once it is beaten. */
export function heroSpot(scene: Pick<Scene, 'width' | 'stops'>, i: number): Spot {
  const xs = stopXs(scene.width, scene.stops.length)
  const stop = scene.stops[i] as SceneStop
  const x = xs[i] as number
  if (!stop.boss) return { x, y: 6 }
  return stop.state === 'done' ? { x, y: 0 } : { x: x - 9, y: 12 }
}

/** Hero position for a scene: stands still, or slides between two spots. */
export function heroPosition(scene: Scene): Spot & { frame: 0 | 1 } {
  const a = heroSpot(scene, scene.hero.at)
  if (scene.hero.at === scene.hero.to || scene.hero.t <= 0) return { ...a, frame: 0 }
  const b = heroSpot(scene, scene.hero.to)
  const t = Math.min(1, scene.hero.t)
  const frame = (scene.hero.step % 2) as 0 | 1
  return {
    x: Math.round(a.x + (b.x - a.x) * t),
    y: Math.round(a.y + (b.y - a.y) * t) - (t < 1 && frame === 1 ? 1 : 0),
    frame: t < 1 ? frame : 0,
  }
}

function blank(w: number, h: number): Pixels {
  return { w, h, data: new Array<number>(w * h).fill(-1) }
}

function put(px: Pixels, x: number, y: number, color: number) {
  if (x < 0 || y < 0 || x >= px.w || y >= px.h) return
  px.data[y * px.w + x] = color
}

function stamp(px: Pixels, sprite: readonly string[], left: number, top: number) {
  sprite.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx += 1) {
      const color = PAL[row[dx] as string]
      if (color !== undefined) put(px, left + dx, top + dy, color)
    }
  })
}

export function drawScene(scene: Scene): Pixels {
  const w = scene.width
  const px = blank(w, SCENE_H)
  const n = scene.stops.length
  const xs = stopXs(w, n)
  const PATH_Y = 16

  // sky bands, then ground
  for (let y = 0; y < SCENE_H; y += 1) {
    const color =
      y < 8 ? (SKY[0] as number) : y < 15 ? (SKY[1] as number) : y < 19 ? (SKY[2] as number) : (GROUND[y - 19] as number)
    for (let x = 0; x < w; x += 1) put(px, x, y, color)
  }
  for (let x = 0; x < w; x += 1) if (x % 4 === 1) put(px, x, 19, GRASS_TUFT)

  // stars (the same ones every time)
  for (let i = 0; i < Math.floor(w / 6); i += 1) {
    put(px, (i * 37 + 11) % w, (i * 5 + 1) % 7, i % 3 === 0 ? 0xffcd75 : 0xf4f4f4)
  }

  // mountains with snowy tips, far behind
  for (const [peak, half, top] of [[Math.round(w * 0.18), 9, 9], [Math.round(w * 0.45), 11, 7], [Math.round(w * 0.7), 8, 10]] as const) {
    for (let y = top; y < 15; y += 1) {
      const reach = Math.round(((y - top + 1) * half) / (15 - top))
      for (let x = peak - reach; x <= peak + reach; x += 1) put(px, x, y, y < top + 2 ? 0xf4f4f4 : 0x566c86)
    }
  }

  // forest: pines between the stops, behind the path
  for (let i = 0; i + 1 < n; i += 1) {
    const gap = (xs[i + 1] as number) - (xs[i] as number)
    if (gap >= 8) {
      const mid = Math.round(((xs[i] as number) + (xs[i + 1] as number)) / 2)
      stamp(px, PINE, mid - 1, 14)
      if (gap >= 11) stamp(px, PINE, mid + 3, 15)
    }
  }

  // the path: gold up to the hero's stop, grey dots beyond
  const last = xs[n - 1] as number
  const first = xs[0] as number
  const reached = scene.stops.reduce((acc, s, i) => (s.state === 'done' ? i + 1 : acc), 0)
  const goldTo = reached === 0 ? first : (xs[Math.min(n - 1, reached)] as number)
  for (let x = first; x <= last; x += 1) {
    if (x <= goldTo) put(px, x, PATH_Y, PATH_DONE)
    else if (x % 2 === 0) put(px, x, PATH_Y, PATH_TODO)
  }

  // landmarks, and the lair at the end
  scene.stops.forEach((stop, i) => {
    const x = xs[i] as number
    if (stop.boss) stamp(px, stop.state === 'done' ? CASTLE_BEATEN : CASTLE, x - 5, 7)
    else stamp(px, stop.state === 'done' ? MARK_DONE : stop.state === 'current' ? MARK_NOW : MARK_TODO, x - 2, 14)
  })

  // the hero on top
  const hero = heroPosition(scene)
  stamp(px, hero.frame === 0 ? HERO : HERO_STEP, hero.x - 2, hero.y)

  if (scene.celebrate) {
    const colors = [0xffcd75, 0xb13e53, 0x73eff7, 0xa7f070, 0xf4f4f4]
    let seed = 20251005
    const roll = (m: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      return (seed >> 8) % m
    }
    for (let i = 0; i < Math.floor(w / 2); i += 1) put(px, roll(w), roll(12), colors[i % colors.length] as number)
  }

  return px
}

export type Flash = 'hit' | 'hurt' | null

/** The boss arena: hero on the left, boss on the right (twice the size). A flash whitens the boss or reddens the hero. */
export function drawArena(width: number, bossHpFraction: number, flash: Flash): Pixels {
  const w = Math.max(30, width)
  const h = 20
  const px = blank(w, h)
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) put(px, x, y, y < 8 ? 0x1a1c2c : y < 14 ? 0x333c57 : y < 17 ? 0x38b764 : 0x257179)
  for (let i = 0; i < Math.floor(w / 6); i += 1) put(px, (i * 29 + 5) % w, (i * 3 + 1) % 6, 0xf4f4f4)
  const shake = flash === 'hit' ? 1 : 0
  const bx = w - 20 + shake
  const bossRows = BOSS.map(row => row.split('').map(c => c + c).join(''))
  const big = bossRows.flatMap(r => [r, r])
  const tint = (rows: string[], to: string) => (flash === 'hit' ? rows.map(r => r.replace(/[RWK]/g, to)) : rows)
  stamp(px, tint(big, 'W'), bx, 3)
  const herox = 6
  const heroRows = flash === 'hurt' ? HERO.map(r => r.replace(/[cbswp]/g, 'R')) : HERO
  stamp(px, heroRows, herox, 10)
  // the boss's HP, as a bar across the top
  const barW = w - 4
  for (let x = 0; x < barW; x += 1) put(px, 2 + x, 1, x < Math.round(barW * Math.max(0, Math.min(1, bossHpFraction))) ? 0xb13e53 : 0x566c86)
  return px
}

// ---- renderers -----------------------------------------------------------------

const HALF = 0x2580 // upper half block: foreground is the top pixel, background the bottom
const DARK = 0x1a1c2c

/** Cells for a Raster: two pixel rows per terminal row. */
export function toCells(px: Pixels): { columns: number; rows: number; cells: string } {
  const rows = Math.ceil(px.h / 2)
  const bytes: number[] = []
  const word = (v: number) => {
    bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255)
  }
  const at = (x: number, y: number) => {
    const c = y < px.h ? (px.data[y * px.w + x] as number) : -1
    return c < 0 ? DARK : c
  }
  for (let row = 0; row < rows; row += 1) {
    for (let x = 0; x < px.w; x += 1) {
      word(HALF)
      word(at(x, row * 2))
      word(at(x, row * 2 + 1))
    }
  }
  return { columns: px.w, rows, cells: toBase64(bytes) }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64 of a byte list. */
export function toBase64(bytes: readonly number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += b === undefined ? '=' : B64[(n >> 6) & 63]
    out += c === undefined ? '=' : B64[n & 63]
  }
  return out
}

const hex = (c: number) => `#${(c & 0xffffff).toString(16).padStart(6, '0')}`

/** SVG markup: one rect per run of equal pixels in a row. */
export function toSvg(px: Pixels, scale: number): string {
  const rects: string[] = []
  for (let y = 0; y < px.h; y += 1) {
    let x = 0
    while (x < px.w) {
      const c = px.data[y * px.w + x] as number
      let end = x + 1
      while (end < px.w && px.data[y * px.w + end] === c) end += 1
      if (c >= 0) rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="${hex(c)}"/>`)
      x = end
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px.w} ${px.h}" width="${px.w * scale}" height="${px.h * scale}" shape-rendering="crispEdges">${rects.join('')}</svg>`
}

/** One line of text for narrow panes: done, here, to do, boss. */
export function textMap(stops: readonly SceneStop[]): string {
  return stops
    .map(s => (s.state === 'done' ? '✔' : s.state === 'current' ? '▶' : s.boss ? '☠' : '○'))
    .join(' ─ ')
}

/** A short spoken description of the map, for readers that cannot see it. */
export function mapAlt(stops: readonly SceneStop[], at: number): string {
  const done = stops.filter(s => s.state === 'done').length
  return `Quest map with ${stops.length} stops, the last one a boss. The hero is at stop ${Math.min(stops.length, at + 1)}. ${done} done.`
}

/** The frames of the walk, as t from 0 to 1. */
export function walkT(step: number, steps: number): number {
  return steps <= 0 ? 1 : Math.min(1, Math.max(0, step / steps))
}

/** The scene for a quest: stop states from the quest, the hero from the quest or from the walk in progress. */
export function sceneFor(q: Quest, walk: QuestWalk | null, width: number): Scene {
  const last = q.stages.length - 1
  const stops: SceneStop[] = q.stages.map((s, i) => ({
    boss: s.kind === 'boss',
    state: s.status === 'done' ? 'done' : q.phase === 'active' && i === q.current ? 'current' : 'todo',
  }))
  const at = q.phase === 'victory' ? last : Math.min(last, Math.max(0, q.current))
  const hero =
    walk === null
      ? { at, to: at, t: 0, step: 0 }
      : { at: Math.min(last, walk.from), to: Math.min(last, walk.to), t: walkT(walk.step, walk.steps), step: walk.step }
  return { width, stops, hero, celebrate: q.phase === 'victory' && walk === null }
}

// ---- title banner ---------------------------------------------------------------

const FONT: Record<string, string[]> = {
  Q: ['111', '101', '101', '111', '001'],
  U: ['101', '101', '101', '101', '111'],
  E: ['111', '100', '110', '100', '111'],
  S: ['111', '100', '111', '001', '111'],
  T: ['111', '010', '010', '010', '010'],
  M: ['101', '111', '111', '101', '101'],
  O: ['111', '101', '101', '101', '111'],
  D: ['110', '101', '101', '101', '110'],
  V: ['101', '101', '101', '101', '010'],
  I: ['111', '010', '010', '010', '111'],
  C: ['111', '100', '100', '100', '111'],
  R: ['110', '101', '110', '101', '101'],
  Y: ['101', '101', '010', '010', '010'],
  ' ': ['00', '00', '00', '00', '00'],
}

/** A pixel-art title: gold letters with a shadow, a framed night-sky panel, hero and boss at the ends. */
export function drawBanner(text: string): Pixels {
  const glyphs = [...text].map(c => FONT[c] ?? (FONT[' '] as string[]))
  const textW = glyphs.reduce((n, g) => n + (g[0] as string).length + 1, -1)
  const w = textW + 2 * 14
  const h = 11
  const px = blank(w, h)
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) put(px, x, y, y < 5 ? 0x1a1c2c : 0x29366f)
  for (let x = 0; x < w; x += 1) for (const y of [0, h - 1]) put(px, x, y, 0xffcd75)
  for (let y = 0; y < h; y += 1) for (const x of [0, w - 1]) put(px, x, y, 0xffcd75)
  for (const [x, y] of [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2]] as const) put(px, x, y, 0xb13e53)
  let x = 14
  for (const g of glyphs) {
    g.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx += 1) {
        if (row[dx] === '1') {
          put(px, x + dx + 1, 3 + dy, 0x5d275d)
          put(px, x + dx, 2 + dy, 0xffcd75)
        }
      }
    })
    x += (g[0] as string).length + 1
  }
  stamp(px, HERO, 4, 2)
  stamp(px, BOSS, w - 11, 2)
  return px
}
