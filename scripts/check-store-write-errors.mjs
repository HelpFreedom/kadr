// Node-side check of src/engine/userStore.ts — the one route the renderer's
// user stores (pose/fx presets, voice-over settings, recent projects) are
// written through. No app.
//
// The bug this guards: a failed write of a preset or of the voice-over
// settings was swallowed by `.catch(() => {})`; only the localStorage cache
// kept the change, and the user never learned the file was not written.
// Cost: the user's presets silently not saved.
// The read-only store file case is walked live, by hand.
// Run: node scripts/check-store-write-errors.mjs
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  // i18n pulls the whole store in; the table's lookup is replaced by the key
  const stubI18n = {
    name: 'stub-i18n',
    setup(b) {
      b.onResolve({ filter: /i18n$/ }, () => ({ path: 'i18n', namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const tr = (k) => k', loader: 'js' }))
    }
  }
  const out = await build({
    stdin: {
      contents: "export { saveUserStore } from './src/engine/userStore'\nexport { useLog } from './src/engine/log'",
      resolveDir: root, loader: 'ts'
    },
    bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stubI18n], logLevel: 'silent'
  })
  mod = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'))
} catch (err) {
  check('src/engine/userStore.ts loads', false, String(err).split('\n')[0])
}
const { saveUserStore, useLog } = mod

const PATH = 'C:\\Users\\u\\AppData\\Roaming\\kadr\\pose-presets.json'
let writes = 0
let fail = true
globalThis.window = {
  kadr: {
    writeUserStore: async () => {
      writes++
      // what main's store:write throws, as Electron hands it to the renderer
      if (fail) throw new Error(`Error invoking remote method 'store:write': Error: ${PATH}: EPERM`)
    }
  }
}

console.warn = () => {} // the log echoes every entry to the console
try {
  const ok = await saveUserStore('pose-presets.json', [])
  const entries = useLog.getState().entries
  const e = entries[entries.length - 1]
  check('a failed user-store write reaches the session log',
    ok === false && writes === 1 && e?.level === 'warn', e ? `${e.level} ${e.source}` : "no entry")
  check('the entry names the file that was not written', !!e && e.msg.includes(PATH), e?.msg)
  check('the entry says what failed, not the IPC plumbing',
    !!e && e.msg.includes('storeWriteFail') && !e.msg.includes('invoking remote'), e?.msg)
  check('it counts as a failure (the log button lights up)', useLog.getState().unseen === 1)

  fail = false
  const ok2 = await saveUserStore('pose-presets.json', [])
  check('a successful write logs nothing', ok2 === true && useLog.getState().entries.length === 1)
} catch (err) {
  check('saveUserStore runs', false, String(err))
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
