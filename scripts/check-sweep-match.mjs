// Node-side check of electron/orphanSweep.ts — which processes the Windows
// startup sweep kills. No app, no PowerShell: the process lists are recorded
// command lines (a hard-killed Kadr in a test profile, mid fragment render).
//
// The bug this guards: sweepStaleSessions read /proc and returned 0 anywhere
// else, so on Windows the vite/ffmpeg/python/remotion helpers of a
// hard-killed run stayed alive. The cost of getting the matcher wrong the
// other way is killing the user's own processes, so most cases here are
// processes that must SURVIVE.
// Run: node scripts/check-sweep-match.mjs
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
  const src = readFileSync(join(root, 'electron', 'orphanSweep.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('electron/orphanSweep.ts loads', false, String(err).split('\n')[0])
}
const { pickWinOrphans, parseWinProcs, WIN_PROCESS_QUERY } = mod

const SB = 'D:\\kadr test'
const UD = `${SB}\\A\\userdata`
const WS = `${SB}\\fragments`
const APP = 'D:\\src\\kadr'
// what the sweep passes: userData, the fragment workspace, the export temp, the app's helper scripts
const marks = [UD, WS, 'C:\\Temp\\kadr-export', `${APP}\\electron\\mcp-bridge.cjs`, `${APP}\\scripts\\transcribe.py`]

const E = `"${APP}\\node_modules\\electron\\dist\\electron.exe"`
const NODE = '"C:\\Program Files\\nodejs\\node.exe"'
// pid, ppid, created (ms), command line — trimmed from a recorded Get-CimInstance list
const procs = [
  [700, 4, 1000, 'C:\\Windows\\explorer.exe'],
  [900, 700, 2000, 'C:\\Windows\\system32\\cmd.exe /c run.mjs'],
  // the NEW Kadr (self = 1200) and its own children
  [1100, 900, 5000, `${NODE} run.mjs --user-data-dir=${UD}`],
  [1200, 1100, 5100, `${E} . --user-data-dir="${UD}" --remote-debugging-port=9777`],
  [1210, 1200, 5200, `${E} --type=renderer --user-data-dir="${UD}" --app-path="${APP}"`],
  [1220, 1200, 5300, `"C:/ffmpeg/bin/ffmpeg.exe" -i x.mp4 ${UD.replace(/\\/g, '/')}/proxies/abc.part.mp4`],
  // the hard-killed Kadr (pid 300, gone): its orphans
  [310, 300, 3000, `${E} --type=crashpad-handler --user-data-dir=${UD} --database=${UD}\\Crashpad`],
  [320, 300, 3100, `node -e "…watchdog…" 300 ${WS}\\node_modules\\vite\\bin\\vite.js --port 5621`],
  [330, 300, 3200, `${NODE} "${WS.toLowerCase()}\\node_modules\\@remotion\\cli\\remotion-cli.js" render src/_entries/current.tsx demo ${UD}\\fragment-renders\\demo-1-q2.part.mp4`],
  [331, 330, 3300, `"${WS}\\node_modules\\.remotion\\chrome-headless-shell\\win64\\chrome-headless-shell.exe" --user-data-dir=${UD}\\render-tmp\\puppeteer_dev_chrome_profile-x`],
  [340, 300, 3400, `"C:\\python\\python.exe" "${APP}/scripts/transcribe.py" --model small`],
  // pid 400 was Kadr, died; 400 is now reused by a process born LATER — the orphan still counts
  [400, 700, 9000, 'C:\\Windows\\notepad.exe'],
  [410, 400, 3500, `"ffmpeg.exe" -f rawvideo -i - C:/Temp/kadr-export/out.mp4`],
  // must survive: the user's own work in the same folders (their shell is alive)
  [500, 900, 6000, `${NODE} ${WS}\\node_modules\\@remotion\\cli\\remotion-cli.js studio`],
  // must survive: an unrelated node and ffmpeg whose parents are gone too
  [600, 250, 1500, `${NODE} C:\\tools\\other\\server.js`],
  [610, 251, 1600, '"ffmpeg.exe" -i C:\\video\\in.mp4 C:\\video\\out.mp4'],
  // must survive: another app's Chromium, parent gone, similar flags
  [620, 252, 1700, '"claude.exe" --type=crashpad-handler --user-data-dir=C:\\Users\\me\\AppData\\Roaming\\Claude'],
  // no command line (access denied), parent gone
  [630, 253, 1800, null]
].map(([pid, ppid, created, cmd]) => ({ pid, ppid, created, cmd }))

if (pickWinOrphans) {
  const got = pickWinOrphans(procs, marks, 1200).sort((a, b) => a - b)
  const want = [310, 320, 330, 340, 410]
  check('the win32 matcher selects only Kadr\'s orphans, never an unrelated node or ffmpeg',
    JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  check('a child of an orphan is left to the tree kill (remotion\'s Chrome)', !got.includes(331))
  check('never self, its own children or its ancestors', ![1100, 1200, 1210, 1220].some((p) => got.includes(p)))
  check('the user\'s own remotion in the workspace survives (parent alive)', !got.includes(500))
  check('no marks, nothing picked', pickWinOrphans(procs, [], 1200).length === 0)
  check('empty marks are ignored, not a match-everything', pickWinOrphans(procs, [''], 1200).length === 0)
}

if (parseWinProcs) {
  const one = parseWinProcs('\uFEFF{"pid":5,"ppid":1,"created":7,"cmd":null}')
  check('a single-process JSON object parses as one entry', one.length === 1 && one[0].pid === 5 && one[0].cmd === null)
  const many = parseWinProcs('[{"pid":5,"ppid":1,"created":7,"cmd":"a"},{"pid":6,"ppid":5,"created":8,"cmd":"b"}]')
  check('an array parses', many.length === 2 && many[1].ppid === 5)
}

if (WIN_PROCESS_QUERY) {
  check('the query keeps created in safe-integer ms', /ToFileTimeUtc\(\)\/10000/.test(WIN_PROCESS_QUERY))
  if (process.platform === 'win32') {
    const { execFileSync } = await import('child_process')
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', WIN_PROCESS_QUERY],
      { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true })
    const list = parseWinProcs(out)
    const me = list.find((p) => p.pid === process.pid)
    check('the live query lists this node with its command line and a safe creation time',
      !!me && !!me.cmd && /check-sweep-match/.test(me.cmd) && Number.isSafeInteger(me.created) && me.created > 0,
      me ? `${list.length} processes` : 'self not found')
    check('this live node is never picked, whatever marks', !pickWinOrphans(list, [root, 'node'], process.pid).includes(process.pid))
  }
}

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
