// Check of src/engine/timelineMath.ts against the slow code it replaced — both
// must give EXACTLY the same numbers:
//
//   1. waveColumns (sliding-window maxima) vs a full scan of every bin a pixel
//      covers, over zooms, speeds, in-points, device pixel ratios and the end of
//      the array;
//   2. trackOverlaps (one sweep) vs comparing every pair of clips, over random
//      tracks with equal starts, butt joints and nested clips;
//   3. tipSpans: edge tips never overlap each other or run past the clip, keep
//      their length when they fit, and share a short clip in proportion.
//
// Pure node, no app.  Run: node scripts/check-timeline.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = transformSync(readFileSync(join(root, 'src', 'engine', 'timelineMath.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code
const { waveColumns, trackOverlaps, tipSpans } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
let seed = 7
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)

// ---- 1. the waveform --------------------------------------------------------
// 5 minutes at 1000 bins/s (+37 so the end is not a round number): silence, a
// one-bin click every 2 s, a slow swell, noise — every shape a pixel may cover
const rate = 1000, n = 300 * rate + 37
const max = new Uint8Array(n), rms = new Uint8Array(n)
for (let i = 0; i < n; i++) {
  const s = i / rate
  const env = s % 10 < 3 ? 0 : s % 2 < 0.001 ? 1 : 0.3 + 0.3 * Math.sin(s)
  max[i] = Math.min(255, Math.round(env * 255 * (0.6 + 0.4 * rnd())))
  rms[i] = Math.round(max[i] * 0.5 * rnd())
}
const wf = { rate, max, rms, windows: new Map() }
let cols = 0, bad = 0, firstBad = ''
for (const zoom of [4, 4.37, 10, 33.3, 40, 200, 999, 1000, 3000]) {
  for (const speed of [1, 1.7, 0.4]) {
    for (const inPoint of [0, 12.345]) {
      for (const dpr of [1, 1.25, 2]) {
        const span = n / rate - inPoint
        const cw = Math.min(5000, Math.floor((span / speed) * zoom * dpr))
        const vis0 = 17
        const got = waveColumns(wf, { cw, vis0, dpr, zoom, speed, inPoint, span })
        const srcPerPx = speed / (zoom * dpr)
        for (let x = 0; x < cw; x++) {
          // the old code, verbatim
          const localT = (vis0 + x / dpr) / zoom
          const srcT = inPoint + ((localT * speed) % span)
          const i0 = Math.floor(srcT * rate)
          const i1 = Math.max(i0 + 1, Math.ceil((srcT + srcPerPx) * rate))
          let p = 0, r = 0
          for (let i = i0; i < i1 && i < n; i++) { if (max[i] > p) p = max[i]; if (rms[i] > r) r = rms[i] }
          cols++
          if (got.peak[x] !== p || got.rms[x] !== r) {
            bad++
            firstBad ||= `zoom ${zoom} speed ${speed} in ${inPoint} dpr ${dpr} x ${x}: ${got.peak[x]}/${got.rms[x]} vs ${p}/${r}`
          }
        }
      }
    }
  }
}
check('waveform columns are exactly the full scan', bad === 0, `${cols} columns, ${bad} differ${firstBad ? '; first: ' + firstBad : ''}`)
check('a one-bin click stays in ONE column when zoomed out', (() => {
  // silence with single full-scale bins: at 4 px/s a column is 250 bins, and
  // each click must light its own column and neither neighbour
  const m = new Uint8Array(60 * rate), r = new Uint8Array(60 * rate)
  const at = [4.0, 6.5, 10.123, 33.999]
  for (const t of at) m[Math.round(t * rate)] = 255
  const c = waveColumns({ rate, max: m, rms: r, windows: new Map() }, { cw: 240, vis0: 0, dpr: 1, zoom: 4, speed: 1, inPoint: 0, span: 60 })
  const lit = [...c.peak].map((v, x) => (v ? x : -1)).filter((x) => x >= 0)
  return JSON.stringify(lit) === JSON.stringify(at.map((t) => Math.floor(t * 4)))
})())
check('few windows kept per waveform', wf.windows.size <= 3, `${wf.windows.size}`)

// ---- 2. overlaps -----------------------------------------------------------
function oldOverlaps(clips) {
  const zones = [], joints = []
  const sorted = [...clips].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i]
    let coverEnd = 0
    for (let j = 0; j < i; j++) {
      const aEnd = sorted[j].start + sorted[j].duration
      if (sorted[j].start < b.start && aEnd > b.start) coverEnd = Math.max(coverEnd, aEnd)
    }
    const to = Math.min(coverEnd, b.start + b.duration)
    if (to > b.start + 1e-6) zones.push({ clip: b, from: b.start, to })
    const a = sorted[i - 1]
    if (Math.abs(a.start + a.duration - b.start) < 0.02) joints.push({ a, b, at: b.start })
  }
  return { zones, joints }
}
const flat = (r) => JSON.stringify({ z: r.zones.map((z) => [z.clip.id, z.from, z.to]), j: r.joints.map((j) => [j.a.id, j.b.id, j.at]) })
let tracks = 0, diff = 0
for (let run = 0; run < 3000; run++) {
  const clips = []
  const count = 1 + Math.floor(rnd() * 40)
  for (let i = 0; i < count; i++) {
    const m = rnd()
    const start = m < 0.2 && clips.length ? clips[Math.floor(rnd() * clips.length)].start // equal starts
      : m < 0.35 && clips.length ? clips[clips.length - 1].start + clips[clips.length - 1].duration // butt joint
        : Math.round(rnd() * 240) / 4
    clips.push({ id: 'c' + i, start, duration: Math.round((0.05 + rnd() * 8) * 20) / 20 })
  }
  tracks++
  if (flat(trackOverlaps(clips)) !== flat(oldOverlaps(clips))) diff++
}
check('overlap zones and joints are exactly the pairwise result', diff === 0, `${tracks} random tracks, ${diff} differ`)
const big = Array.from({ length: 5000 }, (_, i) => ({ id: 'b' + i, start: i * 0.9, duration: 1 + (i % 7) * 0.3 }))
const t0 = performance.now(); trackOverlaps(big); const fast = performance.now() - t0
check('a 5000-clip track in a few milliseconds', fast < 50, `${fast.toFixed(1)} ms`)

// ---- 3. edge tips -----------------------------------------------------------
const tip = (d) => (d ? { type: 'rgbSplit', duration: d } : undefined)
const fits = tipSpans({ duration: 2, transitionIn: tip(0.5), transitionOut: tip(0.3) })
check('tips that fit keep their length', fits.tin === 0.5 && fits.tout === 0.3, JSON.stringify(fits))
const beat = tipSpans({ duration: 1 / 3, transitionIn: tip(0.5), transitionOut: tip(0.5) })
check('two 0.5 s tips on a 1/3 s clip share it and meet in the middle',
  Math.abs(beat.tin - 1 / 6) < 1e-9 && Math.abs(beat.tout - 1 / 6) < 1e-9, JSON.stringify(beat))
const lone = tipSpans({ duration: 0.2, transitionOut: tip(1) })
check('a lone tip fills at most the whole clip', lone.tin === 0 && Math.abs(lone.tout - 0.2) < 1e-9, JSON.stringify(lone))
let wrong = 0
for (let run = 0; run < 5000; run++) {
  const d = 0.05 + rnd() * 3, a = rnd() < 0.2 ? 0 : rnd() * 2, b = rnd() < 0.2 ? 0 : rnd() * 2
  const r = tipSpans({ duration: d, transitionIn: tip(a), transitionOut: tip(b) })
  if (r.tin + r.tout > d + 1e-9 || r.tin > a + 1e-9 || r.tout > b + 1e-9 || (a + b <= d && (r.tin !== a || r.tout !== b))) bad++
}
check('random tips never overlap or run past the clip', wrong === 0, `5000 clips, ${wrong} wrong`)

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exitCode = fails ? 1 : 0
