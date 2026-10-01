// Node-side check of electron/speechPython.ts — which interpreter runs
// faster-whisper. No app, no network, no real Python.
//
// The bug this guards: transcription spawned a bare `python3`, which on a stock
// Windows is the Microsoft Store stub («Python was not found»), so it only
// worked where a launcher script put a venv on PATH. The resolver walks
// KADR_PYTHON → the app's own .venv → `py -3` (win32) → python → python3 and
// accepts the first that imports faster_whisper.
//
// The candidates are faked through a PATH of fake executables: on win32 a copy
// of node.exe named after the candidate (a --require preload decides what it
// does by its own name), elsewhere a sh script.
// Run: node scripts/check-python-resolve.mjs
import { readFileSync, mkdirSync, writeFileSync, copyFileSync, existsSync, rmSync, chmodSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, delimiter } from 'path'
import { tmpdir } from 'os'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const src = readFileSync(join(root, 'electron', 'speechPython.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('electron/speechPython.ts loads', false, String(err).split('\n')[0])
}
const { speechCandidates, resolveSpeechPython, detectorPython } = mod
const win = process.platform === 'win32'

// --- the order of the candidates
if (speechCandidates) {
  const app = join(tmpdir(), 'kadr-pyresolve-app')
  mkdirSync(join(app, '.venv', 'Scripts'), { recursive: true })
  mkdirSync(join(app, '.venv', 'bin'), { recursive: true })
  writeFileSync(join(app, '.venv', 'Scripts', 'python.exe'), '')
  writeFileSync(join(app, '.venv', 'bin', 'python'), '')
  const show = (l) => l.map((c) => [c.command, ...c.args].join(' ')).join(' | ')
  const w = speechCandidates({ env: { KADR_PYTHON: 'C:/py/python.exe' }, platform: 'win32', appPath: app })
  check('win32 order: KADR_PYTHON, the app .venv, py -3, python, python3',
    show(w) === ['C:/py/python.exe', join(app, '.venv', 'Scripts', 'python.exe'), 'py -3', 'python', 'python3'].join(' | '), show(w))
  const l = speechCandidates({ env: {}, platform: 'linux', appPath: app })
  check('linux order: the app .venv, python, python3 (no py launcher)',
    show(l) === [join(app, '.venv', 'bin', 'python'), 'python', 'python3'].join(' | '), show(l))
  const bare = speechCandidates({ env: {}, platform: 'win32', appPath: join(app, 'nowhere') })
  check('a missing .venv is not a candidate', show(bare) === 'py -3 | python | python3', show(bare))
  rmSync(app, { recursive: true, force: true })
}

// --- the resolver skips the Store stub and picks an interpreter that imports faster_whisper
if (resolveSpeechPython) {
  const box = join(tmpdir(), 'kadr-pyresolve-fakes')
  rmSync(box, { recursive: true, force: true })
  const pre = join(box, 'fake.cjs')
  mkdirSync(box, { recursive: true })
  // the fake's behaviour: FAKE_GOOD names the ones that "import faster_whisper",
  // python3 is the Store stub, anything else lacks the package
  writeFileSync(pre, `
const name = process.env.FAKE_NAME || require('path').basename(process.argv0).replace(/\\.exe$/i, '')
// the detector's probe (python >= 3.11 with torch): FAKE_TORCH names the ones that pass
if (process.argv.join(' ').includes('torch')) process.exit((process.env.FAKE_TORCH || '').split(',').includes(name) ? 0 : 1)
if (name === 'python3') { process.stderr.write('Python was not found; run without arguments to install from the Microsoft Store\\n'); process.exit(9009) }
if ((process.env.FAKE_GOOD || '').split(',').includes(name)) { process.stdout.write((process.env.FAKE_CUDA || '1') + '\\n'); process.exit(0) }
process.stderr.write("ModuleNotFoundError: No module named 'faster_whisper'\\n"); process.exit(1)
`)
  const fake = (name) => {
    const dir = join(box, name)
    mkdirSync(dir, { recursive: true })
    if (win) copyFileSync(process.execPath, join(dir, `${name}.exe`))
    else {
      const f = join(dir, name)
      writeFileSync(f, `#!/bin/sh\nFAKE_NAME=${name} exec "${process.execPath}" "${pre}" "$@"\n`)
      chmodSync(f, 0o755)
    }
    return dir
  }
  const dStub = fake('python3'), dPy = fake('python'), dCustom = fake('custom'), d311 = fake('python3.11')
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|kadr_python)$/i.test(k)))
  const envFor = (dirs, extra = {}) => ({ ...base, PATH: dirs.join(delimiter), NODE_OPTIONS: `--require "${pre.replace(/\\/g, '/')}"`, ...extra })
  const nowhere = join(box, 'app')
  const run = (env) => resolveSpeechPython({ env, platform: process.platform, appPath: nowhere })

  const a = await run(envFor([dStub, dPy], { FAKE_GOOD: 'python' }))
  check('the Store stub is skipped and python is picked', a.command === 'python' && !a.error, JSON.stringify(a))
  check('a visible CUDA device reports cuda', a.device === 'cuda', JSON.stringify(a))

  const b = await run(envFor([dStub, dPy], { FAKE_GOOD: 'python', FAKE_CUDA: '0' }))
  check('no CUDA device reports cpu', b.device === 'cpu', JSON.stringify(b))

  const c = await run(envFor([dStub, dPy], { FAKE_GOOD: '' }))
  check('nothing imports faster_whisper → an error', typeof c.error === 'string', JSON.stringify(c))
  check('the error names every candidate tried',
    ['python3', 'python', ...(win ? ['py -3'] : [])].every((n) => c.error?.includes(n)), c.error)
  check('the error quotes why the stub failed', !!c.error?.includes('Python was not found'), c.error)

  const custom = join(dCustom, win ? 'custom.exe' : 'custom')
  const d = await run(envFor([dStub, dPy], { FAKE_GOOD: 'python,custom', KADR_PYTHON: custom }))
  check('KADR_PYTHON wins over python', d.command === custom, JSON.stringify(d))

  const e = await run(envFor([dStub, dPy], { FAKE_GOOD: 'python', KADR_PYTHON: join(box, 'missing.exe') }))
  check('a broken KADR_PYTHON falls through to the next candidate', e.command === 'python', JSON.stringify(e))

  // --- the detector takes the speech interpreter only if it is >= 3.11 with torch; python3.11 goes first
  if (detectorPython) {
    const speech = (env) => () => run(env)
    const det = (dirs, extra) => { const env = envFor(dirs, extra); return detectorPython(env, speech(env), 'python3.11') }
    const f = await det([dStub, dPy], { FAKE_GOOD: 'python', FAKE_TORCH: '' })
    check('detector: a speech python without torch/3.11 is refused → python3.11', f.command === 'python3.11', JSON.stringify(f))
    const g = await det([dStub, dPy], { FAKE_GOOD: 'python', FAKE_TORCH: 'python' })
    check('detector: a speech python with torch and 3.11 is taken', g.command === 'python', JSON.stringify(g))
    const h = await det([dStub, dPy, d311], { FAKE_GOOD: 'python', FAKE_TORCH: 'python,python3.11' })
    check('detector: a qualifying speech python goes before python3.11', h.command === 'python', JSON.stringify(h))
  } else check('detectorPython is exported', false)

  rmSync(box, { recursive: true, force: true })
  check('fakes cleaned up', !existsSync(box))
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
