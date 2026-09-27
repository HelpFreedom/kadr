// Check of shared/hdr.ts — the HDR → SDR conversion behind the proxies,
// intermediates and «для фрагмента» copies of a phone's HLG (or a camera's PQ)
// video. Two parts:
//
//   1. the maths: black stays black, grey stays grey, reference white (HLG
//      75 %, PQ 203 nits) lands near SDR white, brighter goes up smoothly
//      under a shoulder instead of clipping, a BT.2020 colour outside BT.709
//      keeps its hue instead of losing a channel;
//   2. the real pipeline: colour patches encoded as 10-bit BT.2020 (what the
//      phone writes), run through ffmpeg with THE filter chain Kadr uses
//      (hdrFilter + the generated .cube), compared with the formula.
//
// Needs ffmpeg, no app.  Run: node scripts/check-hdr.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared', 'hdr.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { hdrToSdr, hdrCube, hdrFilter, hdrOfTransfer } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const f3 = (v) => v.map((x) => x.toFixed(3)).join(' ')

// ---- 1: the maths ------------------------------------------------------------
check('transfer names', hdrOfTransfer('arib-std-b67') === 'hlg' && hdrOfTransfer('smpte2084') === 'pq' && hdrOfTransfer('bt709') === null)
for (const kind of ['hlg', 'pq']) {
  const z = hdrToSdr(kind, 0, 0, 0)
  check(`${kind}: black stays black`, z.every((x) => Math.abs(x) < 1e-6), f3(z))
  let grey = true, mono = true, prev = -1
  for (let i = 0; i <= 100; i++) {
    const [r, g, b] = hdrToSdr(kind, i / 100, i / 100, i / 100)
    if (Math.abs(r - g) > 1e-4 || Math.abs(g - b) > 1e-4) grey = false
    if (r < prev - 1e-9) mono = false
    prev = r
  }
  check(`${kind}: a grey ramp stays grey`, grey)
  check(`${kind}: …and never goes down`, mono)
  const top = hdrToSdr(kind, 1, 1, 1)[0]
  check(`${kind}: the brightest signal reaches, but does not pass, SDR white`, top > 0.97 && top <= 1, top.toFixed(4))
}
// reference white: HLG 75 % and PQ at 203 nits (signal 0.5806) are the same light
const hw = hdrToSdr('hlg', 0.75, 0.75, 0.75)[0]
const pw = hdrToSdr('pq', 0.58069, 0.58069, 0.58069)[0]
check('reference white lands near SDR white, HLG and PQ alike', hw > 0.9 && hw < 1 && Math.abs(hw - pw) < 0.01, `hlg ${hw.toFixed(3)}, pq ${pw.toFixed(3)}`)
// above reference white the shoulder compresses: not clipped, not linear
const h90 = hdrToSdr('hlg', 0.9, 0.9, 0.9)[0]
check('highlights above reference white are compressed, not clipped', h90 > hw && h90 < 1 && h90 - hw < 0.05, `${hw.toFixed(3)} → ${h90.toFixed(3)}`)
// the whole HDR range stays apart: HLG's peak lands exactly at white, and a
// step between two highlights is still a step (the first curve had them all
// at 1.000 from 1.3× reference white up)
const hs = [0.8, 0.85, 0.9, 0.95].map((v) => hdrToSdr('hlg', v, v, v)[0])
check('highlights stay distinct up to the HDR peak', hs.every((v, i) => i === 0 || v - hs[i - 1] > 0.002) && hs[3] < 0.999,
  hs.map((v) => v.toFixed(4)).join(' < '))
// A colour outside BT.709 is moved towards grey in linear light. A straight
// line to the white point keeps the DOMINANT WAVELENGTH — the hue — so the
// result must lie on the same ray from D65 as the source. (That this green
// comes out a little cyan is right: BT.2020's green primary IS cyaner than
// BT.709's.)
const M2020 = [[0.6370, 0.1446, 0.1689], [0.2627, 0.6780, 0.0593], [0, 0.0281, 1.0610]]
const M709 = [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]]
const xyOf = (M, rgb) => { const X = M.map((r) => r[0] * rgb[0] + r[1] * rgb[1] + r[2] * rgb[2]); const S = X[0] + X[1] + X[2]; return [X[0] / S, X[1] / S] }
const A_ = 0.17883277, B_ = 1 - 4 * A_, C_ = 0.5 - A_ * Math.log(4 * A_)
const hlgInv = (e) => (e <= 0.5 ? (e * e) / 3 : (Math.exp((e - C_) / A_) + B_) / 12)
const inv709 = (v) => (v < 0.081 ? v / 4.5 : Math.pow((v + 0.099) / 1.099, 1 / 0.45))
const hue = ([x, y]) => (Math.atan2(y - 0.3290, x - 0.3127) * 180) / Math.PI
for (const sig of [[0.2, 0.75, 0.2], [0.7, 0.2, 0.6], [0.1, 0.3, 0.7], [0.75, 0.45, 0.1]]) {
  const out = hdrToSdr('hlg', ...sig)
  const h0 = hue(xyOf(M2020, sig.map(hlgInv))), h1 = hue(xyOf(M709, out.map(inv709)))
  const d = Math.abs(((h1 - h0 + 540) % 360) - 180)
  check(`BT.2020 ${sig} → BT.709 keeps its hue (±1°)`, d < 1, `${h0.toFixed(2)}° → ${h1.toFixed(2)}°, out ${f3(out)}`)
}
const red = hdrToSdr('hlg', 0.75, 0, 0)
check('pure BT.2020 red stays red', red[0] > 0.5 && red[0] > red[1] * 3 && red[0] > red[2] * 3, f3(red))
const cube = hdrCube('hlg', 5).trim().split('\n')
check('.cube layout: title, size, size³ rows, red fastest', cube.length === 2 + 125 && cube[1] === 'LUT_3D_SIZE 5' &&
  Number(cube[3].split(' ')[0]) > Number(cube[2].split(' ')[0]) && cube[3].split(' ')[1] === cube[2].split(' ')[1], cube.slice(1, 4).join(' | '))

// ---- 2: the pipeline ---------------------------------------------------------
// patches as HDR signal values (R'G'B', 0..255 of full scale)
const PATCHES = [
  [0, 0, 0], [64, 64, 64], [128, 128, 128], [191, 191, 191], [230, 230, 230], [255, 255, 255],
  [191, 40, 30], [40, 191, 60], [40, 60, 191], [200, 150, 120], [120, 170, 200], [230, 200, 60]
]
const B = 16 // patch size: even, so 4:2:0 chroma never straddles two patches
const W = B * PATCHES.length, H = B
const dir = mkdtempSync(join(tmpdir(), 'kadr-check-hdr-'))
try {
  const rgb = Buffer.alloc(W * H * 3)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) rgb.set(PATCHES[Math.floor(x / B)], (y * W + x) * 3)
  }
  writeFileSync(join(dir, 'in.rgb'), rgb)
  for (const kind of ['hlg', 'pq']) {
    const lut = join(dir, `${kind}.cube`)
    writeFileSync(lut, hdrCube(kind, 33))
    // what the phone writes: 10-bit BT.2020 limited Y'CbCr; then Kadr's chain;
    // then back to R'G'B' as a BT.709 player shows it
    const vf = 'scale=out_color_matrix=bt2020:out_range=tv,format=yuv420p10le,' + hdrFilter(lut) +
      ',scale=in_color_matrix=bt709:in_range=tv:out_range=pc,format=rgb24'
    const out = execFileSync('ffmpeg', ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', join(dir, 'in.rgb'),
      '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 24 })
    let worst = 0, where = ''
    for (let i = 0; i < PATCHES.length; i++) {
      const x = i * B + B / 2, y = H / 2
      const got = [...out.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)]
      const want = hdrToSdr(kind, ...PATCHES[i].map((v) => v / 255)).map((v) => v * 255)
      const d = Math.max(...got.map((g, k) => Math.abs(g - want[k])))
      if (d > worst) { worst = d; where = `patch ${PATCHES[i]}: got ${got}, want ${want.map((v) => v.toFixed(1))}` }
    }
    // LUT interpolation + two 4:2:0 / limited-range round trips: a few units
    check(`${kind}: ffmpeg with Kadr's filter chain matches the formula (≤ 4/255)`, worst <= 4, `worst ${worst.toFixed(1)}; ${where}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exitCode = fails ? 1 : 0
