// Node-side check of shared/argvProject.ts — which argument of a launch names
// the project to open. No app.
//
// The bug this guards: a second Kadr started on the same userData (launched
// twice, a double-click on a .kadr) opened a second editor that could write
// over the first one's project. Now the second instance hands its argv to the
// first (electron/main.ts, `second-instance`), which opens the .kadr found
// here. Cost of a wrong pick: a double-click on a project does nothing, or a
// Chromium switch is read as a file. The lock itself is walked live.
// Run: node scripts/check-argv-project.mjs
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

let argvProject
try {
  const src = readFileSync(join(root, 'shared', 'argvProject.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  ;({ argvProject } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64')))
} catch (err) {
  check('shared/argvProject.ts loads', false, String(err).split('\n')[0])
}

const run = (name, fn) => { try { check(name, fn()) } catch (err) { check(name, false, String(err)) } }
const exe = 'C:\\My Tools\\kadr\\node_modules\\electron\\dist\\electron.exe'

run('a .kadr path in a second instance\'s argv is extracted, other args ignored', () =>
  argvProject([exe, 'C:\\My Tools\\kadr\\.', '--user-data-dir=C:\\My Tools\\kadr-data',
    '--allow-file-access-from-files', 'D:\\Films\\My Cut.KADR']) === 'D:\\Films\\My Cut.KADR')
run('no .kadr in argv → null (a plain second launch only focuses)', () =>
  argvProject([exe, '.', '--user-data-dir=D:\\x', 'D:\\clip.mp4']) === null)
run('a switch whose value ends in .kadr is not a file', () =>
  argvProject([exe, '.', '--open=D:\\a.kadr']) === null)
run('the last .kadr wins when several are passed', () =>
  argvProject([exe, '.', '/home/u/a.kadr', '/home/u/b.kadr']) === '/home/u/b.kadr')
run('empty / missing argv → null', () => argvProject([]) === null && argvProject(undefined) === null)

console.log(fails ? `\n${fails} failed` : '\nall passed')
process.exit(fails ? 1 : 0)
