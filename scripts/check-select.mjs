// Node-side check of src/engine/timelineSelect.ts — which clips a rubber band
// over the lanes catches, and which ones Shift+click puts between two others.
//
// The maths is worth pinning because the answer is invisible: a band that is
// one pixel off catches a neighbouring clip, and the next drag moves a clip
// the user never meant to touch — an edit that looks like the editor lost its
// mind rather than like a selection bug.
// No test runner in the repo: transpile with esbuild, import through a data URL.
// Run: node scripts/check-select.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'src', 'engine', 'timelineSelect.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { clipsInSpan, clipsBetween, unlocked } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())

// v1: a b c back to back, v2: one long clip, a3: a locked audio track
const clip = (id, start, duration) => ({ id, start, duration })
const project = {
  tracks: [
    { id: 'v1', kind: 'video', locked: false,
      clips: [clip('a', 0, 5), clip('b', 5, 5), clip('c', 10, 5)] },
    { id: 'v2', kind: 'video', locked: false, clips: [clip('long', 0, 30)] },
    { id: 'a3', kind: 'audio', locked: true, clips: [clip('mus', 0, 20)] }
  ]
}

// --- the band --------------------------------------------------------------
check('band over one lane catches what it overlaps',
  same(clipsInSpan(project, ['v1'], 4, 6), ['a', 'b']),
  JSON.stringify(clipsInSpan(project, ['v1'], 4, 6)))
check('a lane the band misses contributes nothing',
  same(clipsInSpan(project, ['v2'], 4, 6), ['long']))
check('band across two lanes catches both',
  same(clipsInSpan(project, ['v1', 'v2'], 4, 6), ['a', 'b', 'long']))
check('touching an edge is not catching it',
  same(clipsInSpan(project, ['v1'], 5, 5.000001).filter((id) => id === 'a'), []),
  JSON.stringify(clipsInSpan(project, ['v1'], 5, 5.000001)))
check('a band entirely inside one clip still catches it',
  same(clipsInSpan(project, ['v2'], 10, 12), ['long']))
check('a locked track is never selected',
  same(clipsInSpan(project, ['a3'], 0, 20), []))
check('an unknown track id is ignored',
  same(clipsInSpan(project, ['nope'], 0, 20), []))

// --- Shift+click -----------------------------------------------------------
check('between two clips on one track = they and everything between, that track only',
  same(clipsBetween(project, 'a', 'c'), ['a', 'b', 'c']),
  JSON.stringify(clipsBetween(project, 'a', 'c')))
check('order does not matter',
  same(clipsBetween(project, 'c', 'a'), clipsBetween(project, 'a', 'c')))
check('the same clip twice selects just it',
  same(clipsBetween(project, 'b', 'b'), ['b']),
  JSON.stringify(clipsBetween(project, 'b', 'b')))
check('an unknown id selects nothing',
  same(clipsBetween(project, 'a', 'ghost'), []))
check('the span reaches across the tracks between the two clips',
  same(clipsBetween(project, 'a', 'long'), ['a', 'b', 'c', 'long']),
  JSON.stringify(clipsBetween(project, 'a', 'long')))

// --- the lock survives withLinked --------------------------------------------
// the band and the clicks all pass their result through withLinked(), which
// adds an A/V twin without looking at the lock
check('a locked twin dragged in by withLinked is dropped again',
  same(unlocked(project, ['a', 'mus']), ['a']),
  JSON.stringify(unlocked(project, ['a', 'mus'])))
check('unlocked() keeps the order it was given',
  unlocked(project, ['c', 'mus', 'a']).join() === 'c,a',
  unlocked(project, ['c', 'mus', 'a']).join())
check('an id that is on no track at all is dropped',
  same(unlocked(project, ['ghost']), []))

console.log(fails ? `\n${fails} FAILED` : '\nall good')
process.exit(fails ? 1 : 0)
