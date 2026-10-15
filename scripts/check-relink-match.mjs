// Node-side check of shared/relinkMatch.ts — which file in a folder a missing
// media file is relinked to. No app.
//
// The bug this guards: «Искать в папке» picks the replacement by itself, and a
// wrong pick is the wrong footage silently swapped into the edit. A file is
// taken by its name first, then by size + duration; a candidate must agree on
// what is known (size, duration), must be the ONLY one that fits, and one file
// never serves two missing assets.
// Cost: the wrong footage silently swapped in.
// Run: node scripts/check-relink-match.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const src = readFileSync(join(root, 'shared', 'relinkMatch.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('shared/relinkMatch.ts loads', false, String(err).split('\n')[0])
}
const { relinkMatch, baseName } = mod

if (relinkMatch) {
  // a fake folder: path → { size, duration }; probes are counted
  const disk = {
    'D:\\new\\Interview.MP4': { size: 1000, duration: 12 },
    'D:\\new\\sub\\b-roll renamed.mp4': { size: 2000, duration: 5 },
    'D:\\new\\other.mp4': { size: 2000, duration: 7 }, // same size, different duration
    'D:\\new\\music.wav': { size: 3000, duration: 60 },
    'D:\\new\\music copy.wav': { size: 3000, duration: 60 }, // a twin: ambiguous by size
    'D:\\new\\logo.png': { size: 50, duration: 0 },
    'D:\\new\\take.mp4': { size: 999, duration: 30 } // same NAME as a missing one, different clip
  }
  const files = Object.entries(disk).map(([path, f]) => ({ path, size: f.size }))
  let probes = 0
  const probe = async (p) => { probes++; return disk[p]?.duration ?? null }
  const missing = [
    { id: 'a', path: 'C:/old/interview.mp4', size: 1000, duration: 12 }, // by name (case differs)
    { id: 'b', path: 'C:/old/b-roll.mp4', size: 2000, duration: 5 }, // renamed: size + duration
    { id: 'c', path: 'C:/old/music.mp3', size: 3000, duration: 60 }, // two fit by size+duration: none
    { id: 'd', path: 'C:/old/logo.png', duration: 0 }, // image, no size known: name only
    { id: 'e', path: 'C:/old/take.mp4', size: 400, duration: 8 }, // same name, different clip
    { id: 'f', path: 'C:/old/gone.mp4', duration: 5 } // no size, no name: nothing
  ]
  const r = await relinkMatch(missing, files, probe)
  check('a folder search relinks by name, then size+duration, and never to a different clip',
    r.a === 'D:\\new\\Interview.MP4' && r.b === 'D:\\new\\sub\\b-roll renamed.mp4' &&
    r.d === 'D:\\new\\logo.png' && !('c' in r) && !('e' in r) && !('f' in r),
    JSON.stringify(r))
  check('same size, other duration is not taken', r.b !== 'D:\\new\\other.mp4')
  check('probes only files whose name or size fits', probes <= 6, `${probes} probe(s)`)

  // a name match must agree with the recorded size
  const r2 = await relinkMatch([{ id: 'x', path: '/m/Interview.mp4', size: 1234, duration: 12 }], files, probe)
  check('a same-named file of another size is refused', !('x' in r2), JSON.stringify(r2))

  // one file never serves two missing assets
  const r3 = await relinkMatch([
    { id: 'p', path: '/m/one.mp4', size: 1000, duration: 12 },
    { id: 'q', path: '/m/two.mp4', size: 1000, duration: 12 }
  ], files, probe)
  check('one file is never given to two assets', !('p' in r3) && !('q' in r3), JSON.stringify(r3))

  // a probe that fails (not media) never matches
  const r4 = await relinkMatch([{ id: 'z', path: '/m/interview.mp4', duration: 12 }], files, async () => null)
  check('an unprobeable candidate is refused', !('z' in r4), JSON.stringify(r4))

  check('baseName handles both separators', baseName('C:\\a/b\\c.mp4') === 'c.mp4' && baseName('/x/y.mov') === 'y.mov')
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
