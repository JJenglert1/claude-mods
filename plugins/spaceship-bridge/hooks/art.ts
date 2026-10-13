import { toBase64 } from './bridge'

// Pixel art for the bridge header: one scene, two renderers (terminal cells, SVG).
// Colors are 0xRRGGBB; -1 is empty.

export type Pixels = { w: number; h: number; data: number[] }

const SPACE = 0x0b1020
const FRAME = 0x3b5dc9
const CORNER = 0xffcd75
const TITLE = 0x73eff7
const SHIP = ['.....gg....', '..gggggggg.', 'ggwwggcccgg', '..gggggggg.', '.....gg....']
const SHIP_COLORS: Record<string, number> = { g: 0x94b0c2, w: 0xf4f4f4, c: 0x41a6f6 }
const FONT: Record<string, string[]> = {
  B: ['110', '101', '110', '101', '110'],
  R: ['110', '101', '110', '101', '101'],
  I: ['111', '010', '010', '010', '111'],
  D: ['110', '101', '101', '101', '110'],
  G: ['011', '100', '101', '101', '011'],
  E: ['111', '100', '110', '100', '111'],
}

export const BANNER_H = 16

function hash(a: number, b: number): number {
  let h = Math.imul(a + 0x9e3779b1, 0x85ebca6b) ^ Math.imul(b + 0x27d4eb2f, 0xc2b2ae35)

  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)

  return (h ^ (h >>> 13)) >>> 0
}

/** The viewscreen: stars, a ship, the word BRIDGE, console corners. Frame 0 is the still picture. */
export function drawBridge(w: number, frame: number): Pixels {
  const h = BANNER_H
  const data = new Array<number>(w * h).fill(SPACE)
  const put = (x: number, y: number, c: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) data[y * w + x] = c
  }

  for (let i = 0; i < w; i++) {
    for (let j = 2; j < h - 2; j++) {
      const s = hash(i, j)

      if (s % 23 === 0) put(i, j, [0x566c86, 0xa7b4c4, 0xf4f4f4][(s >>> 9) % 3 === (frame % 3) ? 2 : (s >>> 9) % 2] ?? 0xffffff)
    }
  }

  const scale = w >= 56 ? 2 : 1
  const x0 = 4

  'BRIDGE'.split('').forEach((ch, n) => {
    ;(FONT[ch] ?? []).forEach((row, y) => {
      row.split('').forEach((bit, x) => {
        if (bit !== '1') return
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) put(x0 + n * 4 * scale + x * scale + dx, 3 + y * scale + dy, TITLE)
        }
      })
    })
  })

  const sx = w - SHIP[0]!.length - 4 + (frame % 2)

  SHIP.forEach((row, y) => {
    row.split('').forEach((ch, x) => {
      const c = SHIP_COLORS[ch]

      if (c !== undefined) put(sx + x, 5 + y, c)
    })
  })

  for (let i = 0; i < w; i++) {
    put(i, 0, FRAME)
    put(i, h - 1, FRAME)
  }

  for (let j = 0; j < h; j++) {
    put(0, j, FRAME)
    put(w - 1, j, FRAME)
  }

  for (const [cx, cy] of [[0, 0], [w - 3, 0], [0, h - 3], [w - 3, h - 3]] as const) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) put(cx + a, cy + b, CORNER)
    }
  }

  return { w, h, data }
}

/** Half-block cells for a Raster: two pixel rows per terminal row. */
export function toCells(px: Pixels): { columns: number; rows: number; cells: string } {
  const rows = Math.ceil(px.h / 2)
  const bytes: number[] = []
  const word = (v: number) => bytes.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255)
  const at = (x: number, y: number) => (y < px.h ? (px.data[y * px.w + x] as number) : SPACE)

  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < px.w; x++) {
      word(0x2580)
      word(at(x, row * 2))
      word(at(x, row * 2 + 1))
    }
  }

  return { columns: px.w, rows, cells: toBase64(Uint8Array.from(bytes)) }
}

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

/** The same picture as SVG; with `isAnimated` the stars twinkle (SMIL). */
export function toSvg(px: Pixels, scale: number, isAnimated: boolean): string {
  const rects: string[] = []

  for (let y = 0; y < px.h; y++) {
    for (let x = 0; x < px.w; x++) {
      const c = px.data[y * px.w + x] as number

      if (c === SPACE) continue
      const isStar = c === 0x566c86 || c === 0xa7b4c4 || c === 0xf4f4f4
      const twinkle = isAnimated && isStar ? `<animate attributeName="opacity" values="1;.35;1" dur="${2 + (x % 3)}s" repeatCount="indefinite"/>` : ''

      rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${hex(c)}">${twinkle}</rect>`)
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px.w} ${px.h}" width="${px.w * scale}" height="${px.h * scale}" shape-rendering="crispEdges"><rect width="${px.w}" height="${px.h}" fill="${hex(SPACE)}"/>${rects.join('')}</svg>`
}
