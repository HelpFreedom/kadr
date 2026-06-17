// Generates a placeholder Kadr app icon (build/icon.png) — a white "K" on a
// rounded-rect gradient, drawn by hand so no image tooling is required.
// Run: node build/make-icon.mjs   (then iconutil builds the .icns)
import { deflateSync } from 'zlib'
import { writeFileSync, rmSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { execFileSync } from 'child_process'

const S = 1024
const here = dirname(fileURLToPath(import.meta.url))

// --- tiny geometry helpers ---
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
// signed distance from point to segment a->b
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const t = clamp01(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1))
  const cx = ax + t * dx, cy = ay + t * dy
  return Math.hypot(px - cx, py - cy)
}
function roundRectInside(px, py, x0, y0, x1, y1, r) {
  // returns true if (px,py) is inside the rounded rect
  const qx = Math.max(x0 + r - px, px - (x1 - r), 0)
  const qy = Math.max(y0 + r - py, py - (y1 - r), 0)
  if (px < x0 || px > x1 || py < y0 || py > y1) return false
  return qx * qx + qy * qy <= r * r || (qx === 0 || qy === 0)
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

const TOP = [0x2d, 0x7d, 0xf6]    // blue
const BOT = [0x10, 0x3b, 0x8c]    // deeper blue
const INK = [0xff, 0xff, 0xff]

// K strokes (in icon space, with margin)
const m = S * 0.30           // stem left
const top = S * 0.27, bot = S * 0.73
const mid = S * 0.50
const hw = S * 0.052         // half stroke width
const stems = [
  [m, top, m, bot],          // vertical stem
  [m, mid, S * 0.72, top],   // upper diagonal
  [m, mid, S * 0.72, bot]    // lower diagonal
]

// RGBA buffer
const px = Buffer.alloc(S * S * 4)
const margin = S * 0.085, r = S * 0.225
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    const inBg = roundRectInside(x, y, margin, margin, S - margin, S - margin, r)
    if (!inBg) { px[i + 3] = 0; continue }
    const bg = mix(TOP, BOT, y / S)
    // K coverage with ~1.5px antialias
    let dK = Infinity
    for (const s of stems) dK = Math.min(dK, segDist(x, y, s[0], s[1], s[2], s[3]))
    const kCov = clamp01((hw - dK) / 2 + 0.5)
    const col = mix(bg, INK, kCov)
    px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = 255
  }
}

// --- minimal PNG encoder (RGBA, filter 0) ---
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8; ihdr[9] = 6 // 8-bit, RGBA
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])
const out = join(here, 'icon.png')
writeFileSync(out, png)
console.log('wrote', out, png.length, 'bytes')

// Build the .icns (macOS only — sips/iconutil). The base PNGs are downscaled
// from the 1024² master; @2x variants reuse the next size up.
if (process.platform === 'darwin') {
  const set = join(here, 'icon.iconset')
  rmSync(set, { recursive: true, force: true })
  mkdirSync(set)
  const sips = (sz, name) =>
    execFileSync('sips', ['-z', String(sz), String(sz), out, '--out', join(set, name)], { stdio: 'ignore' })
  for (const s of [16, 32, 128, 256, 512]) {
    sips(s, `icon_${s}x${s}.png`)
    sips(s * 2, `icon_${s}x${s}@2x.png`)
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(here, 'icon.icns')], { stdio: 'inherit' })
  rmSync(set, { recursive: true, force: true })
  console.log('wrote', join(here, 'icon.icns'))
}
