// Node-side check of shared/ffmpegFlags.ts — which spelling hands ffmpeg a
// filter graph from a file. The export's audio graph always goes through a
// file, and the two spellings exclude each other across releases: ffmpeg 9
// has no -filter_complex_script, ffmpeg 6 and older have no -/filter_complex.
// With ffmpeg in PATH it also runs the chosen spelling for real.
// Run: node scripts/check-ffmpegflags.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = transformSync(readFileSync(join(root, 'shared', 'ffmpegFlags.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code
const { filterFileFlag, passthroughFrameArgs } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const NEW = '-/filter_complex'
const OLD = '-filter_complex_script'
for (const [line, want] of [
  ['ffmpeg version n9.0.2 Copyright (c) 2000-2026 the FFmpeg developers', NEW], // Arch
  ['ffmpeg version 7.0.2 Copyright (c) 2000-2024 the FFmpeg developers', NEW],
  ['ffmpeg version 7.1-static https://johnvansickle.com/ffmpeg/', NEW],
  ['ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers', OLD], // Ubuntu 24.04
  ['ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021', OLD], // Ubuntu 22.04
  ['ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024', OLD], // Debian 12
  ['ffmpeg version N-118000-g1234abcd Copyright (c) 2000-2026', NEW], // a development build
  ['', NEW] // ffmpeg did not answer: the export fails either way, so the current spelling
]) {
  check(`«${line.slice(0, 40) || 'no answer'}» → ${want}`, filterFileFlag(line) === want)
}

// frame passthrough: -fps_mode from 5.1, -vsync before (and gone in ffmpeg 9)
for (const [line, want] of [
  ['ffmpeg version n9.0.2 Copyright (c) 2000-2026 the FFmpeg developers', '-fps_mode'],
  ['ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers', '-fps_mode'],
  ['ffmpeg version 5.1.6-0+deb12u1 Copyright (c) 2000-2024', '-fps_mode'], // the first with -fps_mode
  ['ffmpeg version 5.0.3 Copyright (c) 2000-2022', '-vsync'],
  ['ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021', '-vsync'],
  ['ffmpeg version N-118000-g1234abcd Copyright (c) 2000-2026', '-fps_mode'],
  ['', '-fps_mode']
]) {
  const got = passthroughFrameArgs(line)
  check(`passthrough «${line.slice(0, 40) || 'no answer'}» → ${want}`, got[0] === want && got[1] === 'passthrough', got.join(' '))
}

const v = spawnSync('ffmpeg', ['-hide_banner', '-version'], { encoding: 'utf8' })
if (v.status === 0) {
  const flag = filterFileFlag(v.stdout)
  const dir = mkdtempSync(join(tmpdir(), 'kadr-ffflags-'))
  try {
    const graph = join(dir, 'graph.txt')
    writeFileSync(graph, 'anullsrc=r=48000:cl=stereo,atrim=duration=0.1[aout]')
    const run = (f) => spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', f, graph, '-map', '[aout]', '-f', 'null', '-'], { encoding: 'utf8' })
    const r = run(flag)
    check(`the installed ffmpeg (${v.stdout.split('\n')[0].split(' ').slice(0, 3).join(' ')}) runs a graph from a file with ${flag}`, r.status === 0, r.stderr.trim().slice(0, 160))
    const pass = passthroughFrameArgs(v.stdout)
    const d = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=d=0.1', ...pass, '-f', 'null', '-'], { encoding: 'utf8' })
    check(`the installed ffmpeg decodes with ${pass.join(' ')}`, d.status === 0, d.stderr.trim().slice(0, 160))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
} else {
  console.log('SKIP  no ffmpeg in PATH — the live run is skipped')
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
