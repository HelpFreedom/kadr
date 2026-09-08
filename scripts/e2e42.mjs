// Test: the storage panel — what Kadr keeps on disk and what may be deleted.
//
// The whole feature turns on one distinction: a proxy, a decoded intermediate
// and a fragment render are DERIVED (their name is a hash of their source, so
// deleting one costs time and nothing else), while a reversed clip, a
// downloaded file and a voice-over run are REFERENCED by path and cannot be
// derived a second time. Everything below exists to keep that line where it
// is, and to keep the promise that follows from it: wipe the proxies, open the
// project a year later, and it still plays.
//
// Nothing here deletes anything of the user's: the deletion checks work on
// marker files this suite creates itself and names explicitly.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
import WebSocket from 'ws'
import { createHash } from 'crypto'
import { writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync, copyFileSync, statSync } from 'fs'
import { join } from 'path'
const PORT = process.env.KADR_CDP_PORT || 9777

async function getPageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('CDP target not found')
}

let id = 0
let ws
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      ws.off('message', onMsg)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
async function rawEval(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}
async function evalJs(expression, { timeout = 60000 } = {}) {
  const key = `k${Date.now()}_${++id}`
  await rawEval(
    `window.__e2e = window.__e2e || {};` +
    `(async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) }` +
    ` catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`
  )
  const t0 = Date.now()
  for (;;) {
    const raw = await rawEval(`window.__e2e.${key} ?? null`)
    if (raw !== null) {
      const r = JSON.parse(raw)
      if ('err' in r) throw new Error('JS exception: ' + r.err)
      return r.ok
    }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 300))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const key = (k, code, mods = 0) =>
  send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: 0, modifiers: mods })
    .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods }))

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })


const USERDATA = join(process.env.HOME, '.config', 'kadr')
const PROXY_DIR = join(USERDATA, 'proxies')
const PROJ = '/tmp/kadr-test/storage-proj.kadr'
const SRC = '/tmp/kadr-test/storage-src.mp4'   // our own copy: a fake cache
                                              // entry keyed on a REAL asset would be
                                              // served to the preview as its proxy

/** the same formula main names its caches by (electron/cacheKeys.ts) */
const cacheKey = (path, size, mtimeMs, suffix = '') =>
  createHash('sha1').update(`${path}:${size}:${Math.round(mtimeMs)}${suffix}`).digest('hex').slice(0, 20)

// a private copy of a real video, so nothing we invent collides with the
// caches the editor actually uses
copyFileSync('/tmp/kadr-test/hd.mp4', SRC)

const made = []
const marker = (dir, name, bytes = 2048) => {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, Buffer.alloc(bytes, 7))
  made.push(p)
  return p
}

try {
  // ---- a project of our own, saved where we can point at it
  const built = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().setProject({ ...st().project, name: 'storage-test', tracks: [], assets: [] }, null)
    st().addTrack('video')
    const { asset } = await window.kadr.probeMedia(${JSON.stringify(SRC)})
    const id = E.uid()
    st().addAsset({ id, ...asset })
    st().insertClipFromAsset(id, st().project.tracks[0].id, 0)
    await window.kadr.writeProject(${JSON.stringify(PROJ)}, st().project)
    return { assets: st().project.assets.map((a) => a.path) }
  })()`, { timeout: 60000 })
  check('a test project with one real asset exists', built.assets.length === 1, JSON.stringify(built))

  const st = statSync(SRC)
  const ownKey = cacheKey(SRC, st.size, st.mtimeMs)          // what a proxy of it would be called
  const ownFile = marker(PROXY_DIR, `${ownKey}.mp4`)
  const orphanFile = marker(PROXY_DIR, 'e2e42-orphan-name.mp4')

  // ---- 1. the scan sees the whole picture and labels it correctly
  const scan = await evalJs(`window.kadr.storageScan([${JSON.stringify(PROJ)}], null)`)
  const byId = Object.fromEntries(scan.groups.map((g) => [g.id, g]))
  check('every storage group is reported', scan.groups.length === 7 &&
        ['proxies', 'decoded', 'fragments', 'ttsqcCache', 'reversed', 'imported', 'voiceRuns']
          .every((id) => byId[id]), scan.groups.map((g) => g.id).join(','))
  check('derived caches are marked rebuildable, referenced files are not',
        byId.proxies.rebuildable && byId.decoded.rebuildable && byId.fragments.rebuildable &&
        !byId.reversed.rebuildable && !byId.imported.rebuildable && !byId.voiceRuns.rebuildable,
        JSON.stringify(scan.groups.map((g) => [g.id, g.rebuildable])))

  // ---- 2. a cache file is tied to the project that would produce its name
  const mine = byId.proxies.byProject.find((p) => p.id === PROJ)
  check('a cache entry is attributed to the project whose source produces it',
        !!mine && mine.files >= 1, JSON.stringify(byId.proxies.byProject))
  check('and one no project can produce counts as nobody\'s',
        byId.proxies.stale.files >= 1, JSON.stringify(byId.proxies.stale))
  check('projects are told apart by path, not by name',
        scan.projects.every((p) => p.id) && scan.projects[0].id === PROJ,
        JSON.stringify(scan.projects))

  // ---- 3. deletion obeys the scope. Restricted to our own marker files, so
  // this suite can never take a gigabyte of somebody's real cache with it.
  const dry = await evalJs(`window.kadr.storagePrune(${JSON.stringify({
    group: 'proxies', scope: 'stale', projects: [PROJ], dryRun: true,
    only: [`${ownKey}.mp4`, 'e2e42-orphan-name.mp4']
  })})`)
  check('a dry run counts only what nobody claims', dry.removed === 1, JSON.stringify(dry))
  check('and deletes nothing', existsSync(ownFile) && existsSync(orphanFile))

  // no confirm → nothing may go, however the scope reads
  const unconfirmed = await evalJs(`window.kadr.storagePrune(${JSON.stringify({
    group: 'proxies', scope: 'stale', projects: [PROJ],
    only: [`${ownKey}.mp4`, 'e2e42-orphan-name.mp4']
  })})`)
  check('a request that does not say "delete" deletes nothing',
        existsSync(orphanFile) && existsSync(ownFile), JSON.stringify(unconfirmed))

  const real = await evalJs(`window.kadr.storagePrune(${JSON.stringify({
    group: 'proxies', scope: 'stale', projects: [PROJ], confirm: true,
    only: [`${ownKey}.mp4`, 'e2e42-orphan-name.mp4']
  })})`)
  check('deleting the orphan leaves the project\'s own file alone',
        real.removed === 1 && existsSync(ownFile) && !existsSync(orphanFile), JSON.stringify(real))

  // ---- 4. a file the project cannot rebuild is never deleted as "its own"
  const refused = await evalJs(`window.kadr.storagePrune(${JSON.stringify({
    group: 'reversed', scope: 'project', project: PROJ, projects: [PROJ], confirm: true
  })})`)
  check('a non-rebuildable group refuses a per-project wipe',
        refused.error === 'not rebuildable' && refused.removed === 0, JSON.stringify(refused))

  // ---- 5. THE PROMISE: wipe a proxy, and the project still plays.
  // Before this, the rebuilt proxy landed under the SAME name, so nothing in
  // the store changed, the failed <video> was never told to reload, and the
  // clip stayed black until something else touched it.
  const healed = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const a = st().project.assets[0]
    // pretend a cleanup wiped the proxy the project remembers
    st().updateAsset(a.id, { proxyPath: '/tmp/kadr-test/gone-proxy-' + Date.now() + '.mp4' })
    const before = st().project.assets[0].proxyPath
    for (let i = 0; i < 40 && st().project.assets[0].proxyPath === before; i++) {
      await new Promise((r) => setTimeout(r, 250))
    }
    const after = st().project.assets[0].proxyPath
    return { before, after, cleared: after !== before }
  })()`, { timeout: 30000 })
  check('a proxy that is gone from disk stops being referenced',
        healed.cleared === true, JSON.stringify(healed))

  // and the preview keeps decoding: the pool falls back to the original
  // The elements the preview decodes into live in the MediaPool, not in the
  // document, so the honest question is not "what is the src" but "is there a
  // picture". A clip pointed at a deleted proxy draws black for the rest of
  // the session; colour bars mean the fallback and the rebuild did their job.
  const bright = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().setPlayhead(0.4)
    await new Promise((r) => setTimeout(r, 2500))
    const cv = document.querySelector('.preview-canvas-wrap canvas')
    const c2 = document.createElement('canvas')
    c2.width = cv.width
    c2.height = cv.height
    const g = c2.getContext('2d')
    g.drawImage(cv, 0, 0)
    const d = g.getImageData(0, 0, cv.width, cv.height).data
    let mx = 0
    for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i], d[i + 1], d[i + 2])
    return { brightest: mx, proxy: st().project.assets[0].proxyPath ?? null }
  })()`, { timeout: 40000 })
  check('the clip still draws a picture after its proxy was wiped',
        bright.brightest > 40, JSON.stringify(bright))

  // ---- 6. the scan survives a project file that no longer exists
  const missing = await evalJs(`window.kadr.storageScan(['/tmp/kadr-test/no-such-project.kadr'], null)`)
  check('an unreadable project is skipped, not fatal',
        Array.isArray(missing.groups) && missing.projects.length === 0, JSON.stringify(missing.projects))
} finally {
  for (const p of made) { try { rmSync(p, { force: true }) } catch { /* already gone */ } }
  try { unlinkSync(PROJ) } catch { /* never written */ }
  try { unlinkSync(SRC) } catch { /* never copied */ }
  ws.close()
}
console.log('e2e42 finished')
