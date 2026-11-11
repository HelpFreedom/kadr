// Check of the packed alpha intermediate (electron/ffmpeg.ts makeDecoded with
// {packed: true}) on the installed ffmpeg — the REAL function, bundled with
// esbuild, run on synthetic VP9+alpha sources made losslessly here.
//
// Every transparent fragment of an export goes through this pack: its colour
// over its alpha matte in one lossless H.264 file, split apart again by the
// compositor. Two faults were measured on ffmpeg ≥ 8 (and reported for 8.1 in
// HelpFreedom/kadr#48):
//   • the matte was compressed to limited range TWICE — gray→yuv420p already
//     lands in 16…235 there, and `scale=in_range=pc:out_range=tv` came after
//     it — so opaque 255 packed as 218 (alpha ≈ 0.92: the layer under a
//     fragment showed through) and clear 0 as 30 (a ≈ 6 % veil wherever the
//     fragment was empty);
//   • swscale's BT.601→BT.709 matrix change moved colours by up to 2.4 levels
//     and turned neutral grey green-ish (126,128,128 → 125,128,127).
// Asserted here: the matte round-trips EXACTLY for every alpha band; on
// ffmpeg ≥ 8 the colour lands within 1 level of a float BT.601→BT.709
// reference; a BT.709 source's samples are copied verbatim.
// Run: node scripts/check-packed-alpha.mjs   (needs ffmpeg with libvpx)
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const version = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' })
if (version.status !== 0) {
  console.log('SKIP  no ffmpeg in PATH')
  process.exit(0)
}
const major = Number(/ffmpeg version\s+n?(\d+)\./i.exec(version.stdout)?.[1] ?? 99)

const dir = mkdtempSync(join(tmpdir(), 'kadr-packcheck-'))
try {
  const bundle = join(dir, 'ffmpeg.mjs')
  await build({
    entryPoints: [join(root, 'electron', 'ffmpeg.ts')], bundle: true, platform: 'node', format: 'esm',
    outfile: bundle, logLevel: 'error', alias: { '@shared': join(root, 'shared') }
  })
  const { makeDecoded, packedAlphaPlan } = await import(pathToFileURL(bundle).href)

  // a W×H frame: 32 colour patches (16×16) of BT.601 limited Y'CbCr, and alpha
  // in four vertical bands of 0 / 128 / 200 / 255
  const W = 128, H = 64
  const BANDS = [0, 128, 200, 255]
  let seed = 7
  const rnd = (a, b) => { seed = (seed * 1103515245 + 12345) % 2147483648; return a + (seed % (b - a + 1)) }
  const patches = [[126, 128, 128], [235, 128, 128], [16, 128, 128], [81, 90, 240], [145, 54, 34], [41, 240, 110],
    [170, 166, 16], [106, 202, 222], [60, 100, 100], [180, 150, 90], [100, 140, 160], [126, 110, 150]]
  while (patches.length < 32) patches.push([rnd(30, 220), rnd(60, 196), rnd(60, 196)])
  const Y = Buffer.alloc(W * H), U = Buffer.alloc(W * H / 4), V = Buffer.alloc(W * H / 4), A = Buffer.alloc(W * H)
  patches.forEach(([y, u, v], i) => {
    const px = (i % 8) * 16, py = Math.floor(i / 8) * 16
    for (let r = py; r < py + 16; r++) for (let c = px; c < px + 16; c++) Y[r * W + c] = y
    for (let r = py / 2; r < py / 2 + 8; r++) for (let c = px / 2; c < px / 2 + 8; c++) { U[r * W / 2 + c] = u; V[r * W / 2 + c] = v }
  })
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) A[r * W + c] = BANDS[Math.floor(c / 32)]
  const raw = join(dir, 'src.yuva')
  const frame = Buffer.concat([Y, U, V, A])
  writeFileSync(raw, Buffer.concat([frame, frame, frame]))

  // lossless VP9+alpha of exactly these samples. A BT.709 source is tagged in
  // the bitstream AFTER encoding (vp9_metadata): tagging at encode time makes
  // ffmpeg convert the untagged input into BT.709 first, and the source would
  // no longer hold the samples it is compared with
  const makeSource = (name, bt709) => {
    const out = join(dir, name)
    const plain = bt709 ? out.replace(/\.webm$/, '.plain.webm') : out
    const run = (args) => {
      const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
      if (r.status !== 0) throw new Error('could not make the VP9+alpha source: ' + r.stderr)
    }
    run(['-f', 'rawvideo', '-pix_fmt', 'yuva420p', '-s', `${W}x${H}`, '-r', '30', '-i', raw,
      '-c:v', 'libvpx-vp9', '-lossless', '1', '-pix_fmt', 'yuva420p', plain])
    if (bt709) run(['-i', plain, '-c', 'copy', '-bsf:v', 'vp9_metadata=color_space=bt709', out])
    return out
  }
  const pack = async (src) => {
    const plan = await packedAlphaPlan(src)
    const out = src.replace(/\.webm$/, '.pack.mp4')
    await makeDecoded(src, out, 0.1, undefined, { packed: true, alpha: true, codec: 'vp9', matrix: plan.matrix })
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { maxBuffer: 1 << 24 })
    return { plan, yuv: r.stdout }
  }

  // ---- an untagged source (what Remotion renders): read as BT.601
  const untagged = await pack(makeSource('untagged.webm', false))
  check('an untagged source is planned as BT.601', untagged.plan.matrix === 'bt601', untagged.plan.matrix)
  check('the pack stacks colour over matte (2× height)', untagged.yuv.length === W * 2 * H * 3 / 2, `${untagged.yuv.length} bytes`)
  const PY = untagged.yuv.subarray(0, W * 2 * H)
  for (const [k, a] of BANDS.entries()) {
    const y = PY[(H + H / 2) * W + k * 32 + 16]
    const back = Math.round((y - 16) * 255 / 219)
    check(`matte: alpha ${a} packs to ${y} and decodes back to exactly ${a}`, back === a && y >= 16 && y <= 235, `back ${back}`)
  }

  const ref = (y, u, v) => {
    const Yf = (y - 16) / 219, Pb = (u - 128) / 224, Pr = (v - 128) / 224
    const R = Yf + 1.402 * Pr, B = Yf + 1.772 * Pb, G = (Yf - 0.299 * R - 0.114 * B) / 0.587
    if (Math.min(R, G, B) < 0 || Math.max(R, G, B) > 1) return null // outside the gamut: no defined answer
    const Y2 = 0.2126 * R + 0.7152 * G + 0.0722 * B
    return [16 + 219 * Y2, 128 + 224 * (B - Y2) / 1.8556, 128 + 224 * (R - Y2) / 1.5748]
  }
  const PU = untagged.yuv.subarray(W * 2 * H, W * 2 * H + W * H / 2)
  const PV = untagged.yuv.subarray(W * 2 * H + W * H / 2)
  let worst = 0, n = 0
  patches.forEach(([y, u, v], i) => {
    const r = ref(y, u, v)
    if (!r) return
    const px = (i % 8) * 16 + 8, py = Math.floor(i / 8) * 16 + 8
    const got = [PY[py * W + px], PU[(py / 2) * W / 2 + px / 2], PV[(py / 2) * W / 2 + px / 2]]
    worst = Math.max(worst, ...got.map((g, j) => Math.abs(g - r[j])))
    n++
  })
  if (major >= 8) {
    check(`colour: ${n} in-gamut patches within 1 level of BT.601→BT.709 (ffmpeg ${major})`, worst <= 1, `worst ${worst.toFixed(2)}`)
    const g = [PY[8 * W + 8], PU[4 * W / 2 + 4], PV[4 * W / 2 + 4]]
    check('colour: neutral grey stays neutral', g[0] === 126 && g[1] === 128 && g[2] === 128, g.join(','))
  } else {
    console.log(`NOTE  ffmpeg ${major}: the colour step keeps swscale (not measured on this release); worst ${worst.toFixed(2)}`)
  }

  // ---- a BT.709 source: nothing to convert, samples copied verbatim
  const tagged = await pack(makeSource('bt709.webm', true))
  check('a BT.709 source is planned as BT.709', tagged.plan.matrix === 'bt709', tagged.plan.matrix)
  const TY = tagged.yuv.subarray(0, W * H)
  const TU = tagged.yuv.subarray(W * 2 * H, W * 2 * H + W * H / 4)
  check('a BT.709 source\'s picture is copied verbatim', TY.equals(Y) && TU.equals(U))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
