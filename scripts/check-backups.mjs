// Node-side check of shared/backups.ts — which project backups are kept and
// which one is offered back after a crash. No app.
//
// The bugs this guards: autosave was one file, overwritten, with no reader —
// a hard kill lost the session unless the user knew where to look. Versions
// must stay bounded (count AND bytes: a 78 MB project × 10 is 780 MB) without
// ever dropping the newest, and the offer must name a backup that is really
// newer than what is on disk.
// Cost: unbounded disk growth, or the only good version pruned.
// Run: node scripts/check-backups.mjs
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
  const src = readFileSync(join(root, 'shared', 'backups.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('shared/backups.ts loads', false, String(err).split('\n')[0])
}
const { backupsToPrune, pickRestore } = mod
const MB = 1024 * 1024

if (backupsToPrune) {
  // rotation keeps the newest N under the byte cap
  const files = Array.from({ length: 14 }, (_, i) => ({ name: `v${i}.kadr`, size: 10 * MB, mtime: 1000 + i }))
  const gone = backupsToPrune(files, 10, 500 * MB).map((f) => f.name).sort()
  check('count: 14 small versions → the 4 oldest go', gone.join() === ['v0.kadr', 'v1.kadr', 'v2.kadr', 'v3.kadr'].join(), gone.join())

  const big = Array.from({ length: 10 }, (_, i) => ({ name: `b${i}.kadr`, size: 78 * MB, mtime: 2000 + i }))
  const bigGone = new Set(backupsToPrune(big, 10, 500 * MB).map((f) => f.name))
  const kept = big.filter((f) => !bigGone.has(f.name))
  check('bytes: 10 × 78 MB → only what fits in 500 MB stays', kept.length === 6 && kept.reduce((n, f) => n + f.size, 0) <= 500 * MB, `${kept.length} kept`)
  check('bytes: the kept ones are the newest', kept.every((f) => f.mtime >= 2004))

  const huge = [{ name: 'old.kadr', size: 10 * MB, mtime: 1 }, { name: 'new.kadr', size: 900 * MB, mtime: 2 }]
  const hugeGone = backupsToPrune(huge, 10, 500 * MB).map((f) => f.name)
  check('the newest is kept even alone over the cap', !hugeGone.includes('new.kadr') && hugeGone.includes('old.kadr'), hugeGone.join())
  check('nothing to prune under both limits', backupsToPrune(files.slice(0, 3), 10, 500 * MB).length === 0)
}

if (pickRestore) {
  // the restore candidate is newer than the project file
  const since = 5000
  const c = [
    { file: 'a/older-than-save.kadr', mtime: 6000, projectMtime: 7000 },
    { file: 'b/newer-than-save.kadr', mtime: 6500, projectMtime: 6000 },
    { file: 'c/unsaved.kadr', mtime: 6200, projectMtime: null }
  ]
  check('the newest backup newer than its project file wins', pickRestore(c, since)?.file === 'b/newer-than-save.kadr', pickRestore(c, since)?.file)
  check('a backup older than its saved project is never offered',
    pickRestore([c[0]], since) === null)
  check('an unsaved project (no file) is offered', pickRestore([c[2]], since)?.file === 'c/unsaved.kadr')
  check('a backup from before the crashed session is not offered again',
    pickRestore([{ file: 'x.kadr', mtime: 4000, projectMtime: null }], since) === null)
  check('no lock → no offer', pickRestore(c, null) === null)
}

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exit(fails ? 1 : 0)
