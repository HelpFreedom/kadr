// Node-side check of src/engine/discardGuard.ts — the decision New, Open and
// closing the window consult before they replace the project. No app.
//
// The bug this guards: «Новый проект», «Открыть» and closing the window threw
// the open project away without a question, although the dirty dot knew it had
// unsaved changes. Cost: silent loss of an edit session.
// The dialog itself is walked live (by hand).
// Run: node scripts/check-discard-guard.mjs
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
  const src = readFileSync(join(root, 'src', 'engine', 'discardGuard.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('src/engine/discardGuard.ts loads', false, String(err).split('\n')[0])
}
const { needsConfirm } = mod
const run = (name, fn) => { try { fn() } catch (err) { check(name, false, String(err)) } }

const saved = { id: 'p', name: 'a', tracks: [] }
const edited = { ...saved, name: 'b' } // every edit is a new project object

run('a dirty project is never replaced without an answer', () => {
  check('a dirty project is never replaced without an answer', needsConfirm(edited, saved) === true)
})
run('an unchanged project replaces silently', () => {
  check('an unchanged project replaces silently', needsConfirm(saved, saved) === false)
})
run('nothing recorded yet is not unsaved work', () => {
  check('nothing recorded yet is not unsaved work', needsConfirm(edited, null) === false)
})

console.log(fails ? `${fails} check(s) failed` : 'all passed')
process.exit(fails ? 1 : 0)
