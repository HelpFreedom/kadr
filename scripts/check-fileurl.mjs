// Node-side check of electron/clipboardFiles.ts — how a pasted file becomes a
// path. No app, no network.
//
// The bug this guards: the paste handler read `new URL(u).pathname`, which for
// file:///C:/x gives "/C:/x" (and never decodes a UNC host); and on Windows
// Electron's clipboard.read('text/uri-list') is "" even with files copied in
// Explorer (they sit in CF_HDROP), so the paste imported nothing at all.
// Run: node scripts/check-fileurl.mjs          (win32 adds a live clipboard round trip)
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const src = readFileSync(join(root, 'electron', 'clipboardFiles.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('electron/clipboardFiles.ts loads', false, String(err).split('\n')[0])
}
const { uriListToPaths, readWinFileDrop } = mod

const win = process.platform === 'win32'
const samples = win
  ? ['C:\\Users\\me\\Видео\\a b#1%.mp4', 'D:\\AI Projects\\kadr\\x.png']
  : ['/home/me/Видео/a b#1%.mp4', '/tmp/x.png']
const list = ['# comment', ...samples.map((p) => pathToFileURL(p).href), 'https://example.com/y.mp4', ''].join('\r\n')
const got = uriListToPaths ? uriListToPaths(list) : []
check('a file:// URL of a Windows path round-trips to the same path',
  JSON.stringify(got) === JSON.stringify(samples), JSON.stringify(got))
check('a malformed file URL is skipped, not thrown',
  uriListToPaths ? uriListToPaths('file://%zz\nfile:///ok').length <= 1 : false)

if (win) {
  const dir = mkdtempSync(join(tmpdir(), 'kadr-fileurl-'))
  const files = [join(dir, 'a b.txt'), join(dir, 'ж #1.txt')]
  for (const f of files) writeFileSync(f, 'x')
  const q = (s) => `'${s.replace(/'/g, "''")}'`
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Set-Clipboard -Path ${files.map(q).join(',')}`])
  const drop = readWinFileDrop ? await readWinFileDrop() : []
  check('files copied like Explorer does come back in order, non-ASCII intact',
    JSON.stringify(drop) === JSON.stringify(files), JSON.stringify(drop))
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Value x'])
  const none = readWinFileDrop ? await readWinFileDrop() : ['?']
  check('text on the clipboard gives no files', none.length === 0, JSON.stringify(none))
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
