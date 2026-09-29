// Node-side check of electron/atomicWrite.ts — how main writes the project,
// its autosave and the user stores. No app.
//
// The bug this guards: `project:write` was a plain fs.writeFile over the
// user's only copy (up to ~78 MB), so a crash, a full disk or a locked file
// mid-write left a torn or empty project. Cost: the user's only copy destroyed.
// Run: node scripts/check-atomic-write.mjs
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, chmodSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
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
  const src = readFileSync(join(root, 'electron', 'atomicWrite.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('electron/atomicWrite.ts loads', false, String(err).split('\n')[0])
}
const { atomicWrite } = mod
const dir = mkdtempSync(join(tmpdir(), 'kadr-atomic-'))
const sidecars = (d) => readdirSync(d).filter((f) => f.includes('.part-'))

if (atomicWrite) {
  // a successful write leaves no sidecar
  const p = join(dir, 'ok.kadr')
  writeFileSync(p, 'old')
  const big = JSON.stringify({ tracks: Array.from({ length: 20000 }, (_, i) => ({ id: i, name: 'клип ' + i })) })
  await atomicWrite(p, big)
  check('a successful write lands the new content', readFileSync(p, 'utf8') === big)
  await atomicWrite(join(dir, 'fresh.kadr'), Buffer.from('buf'))
  check('a new file is created (Buffer input)', readFileSync(join(dir, 'fresh.kadr'), 'utf8') === 'buf')
  check('a successful write leaves no sidecar', sidecars(dir).length === 0, sidecars(dir).join(', '))

  // a failed write leaves the previous project readable
  // (win32: a read-only target refuses the rename; POSIX: a read-only folder
  // refuses the sidecar — either way the write must fail and touch nothing)
  const rdir = join(dir, 'ro')
  mkdirSync(rdir)
  const rp = join(rdir, 'only-copy.kadr')
  const original = JSON.stringify({ name: 'the only copy', clips: [1, 2, 3] }, null, 1)
  writeFileSync(rp, original)
  if (process.platform === 'win32') chmodSync(rp, 0o444)
  else chmodSync(rdir, 0o555)
  let err = null
  const t0 = Date.now()
  try { await atomicWrite(rp, '{"torn":') } catch (e) { err = e }
  const ms = Date.now() - t0
  if (process.platform === 'win32') chmodSync(rp, 0o666)
  else chmodSync(rdir, 0o755)
  check('a failed write rejects with the reason', !!err && /EPERM|EACCES|EBUSY/.test(String(err?.code ?? err)), String(err?.code ?? err))
  check('a failed write leaves the previous project readable',
    readFileSync(rp, 'utf8') === original && JSON.parse(readFileSync(rp, 'utf8')).name === 'the only copy')
  check('a failed write leaves no sidecar', sidecars(rdir).length === 0, sidecars(rdir).join(', '))
  check('a locked target is retried, not given up at once', process.platform !== 'win32' || ms >= 300, `${ms} ms`)

  // a missing folder fails loudly too, and creates nothing
  let err2 = null
  try { await atomicWrite(join(dir, 'nope', 'x.kadr'), 'x') } catch (e) { err2 = e }
  check('a missing folder rejects', err2?.code === 'ENOENT', String(err2?.code ?? err2))
}

rmSync(dir, { recursive: true, force: true })
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
