// Preview smoothness bench: plays [from, to] of the OPEN project over CDP and
// measures what the eye sees. The editor's own frames, and inside every
// fragment iframe that appears: animation frames, frames in which WebGL really
// drew (a draw call happened), and the longest gap between drawn frames while
// that iframe was the visible, playing one. Around every fragment cut it also
// reports the worst gaps — that is where the preview used to fall apart.
//
//   node scripts/preview-bench.mjs <from> <to> [port=9777]
//
// Plays sound. Leaves the playhead where it found it. Read-only otherwise.
import WebSocket from 'ws'

const [from, to] = [Number(process.argv[2]), Number(process.argv[3])]
const PORT = Number(process.argv[4] || 9777)
if (!(to > from)) { console.error('usage: preview-bench.mjs <from> <to> [port]'); process.exit(2) }

const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false })
  let id = 0
  const pending = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const ready = new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
  const evaluate = async (expression) => {
    await ready
    const n = ++id
    return new Promise((resolve) => {
      pending.set(n, (m) => resolve(m.result?.result?.value))
      ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
      setTimeout(() => { if (pending.has(n)) { pending.delete(n); resolve(undefined) } }, 800)
    })
  }
  return { ws, evaluate, close: () => ws.close() }
}

// counts frames and WebGL-drawn frames; installed once per page
const PROBE = `(() => {
  if (window.__bench) return 'again'
  const b = window.__bench = { raf: [], drawn: [], draws: 0 }
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue
    for (const f of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements']) {
      const o = C.prototype[f]
      if (!o) continue
      C.prototype[f] = function (...a) { b.draws++; return o.apply(this, a) }
    }
  }
  let last = 0
  const tick = (t) => {
    b.raf.push(performance.timeOrigin + t)
    if (b.draws !== last) { b.drawn.push(performance.timeOrigin + t); last = b.draws }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return 'ok'
})()`
const TAKE = `(() => { const b = window.__bench; if (!b) return null; const o = { raf: b.raf, drawn: b.drawn, comp: new URLSearchParams(location.search).get('comp') }; b.raf = []; b.drawn = []; return o })()`

const editorT = (await list()).find((t) => t.type === 'page' && t.title === 'Kadr')
if (!editorT) { console.error('no Kadr page on port', PORT); process.exit(1) }
const ed = connect(editorT.webSocketDebuggerUrl)
const S = 'window.kadrEditor.useEditor.getState()'
const project = await ed.evaluate(`(() => { const p = ${S}.project; return { fps: p.fps, clips: p.tracks.flatMap((t) => t.clips.filter((c) => c.kind === 'remotion').map((c) => ({ id: c.id, frag: c.fragmentId, start: c.start, end: c.start + c.duration }))) } })()`)
const saved = await ed.evaluate(`${S}.playhead`)
await ed.evaluate(`${S}.setPlaying(false), ${S}.setPlayhead(${from}), 0`)
console.log(`bench ${from}–${to} s, ${project.clips.length} fragment clips; letting the preview settle 5 s…`)
await new Promise((r) => setTimeout(r, 5000))

// the editor's own frames + which clip is visible at each of them
await ed.evaluate(`(() => { const b = window.__benchEd = { f: [] }; const tick = (t) => { if (!window.__benchEd) return; b.f.push([performance.timeOrigin + t, ${S}.playhead]); requestAnimationFrame(tick) }; requestAnimationFrame(tick); return 0 })()`)

const frames = new Map() // target id → {conn, comp, raf[], drawn[]}
let stop = false
const poll = async () => {
  while (!stop) {
    const live = await list()
    const alive = new Set(live.map((t) => t.id))
    for (const t of live) {
      if (t.type !== 'iframe' || !t.url.includes('comp=') || frames.has(t.id)) continue
      const c = connect(t.webSocketDebuggerUrl)
      const rec = { conn: c, comp: new URL(t.url).searchParams.get('comp'), raf: [], drawn: [] }
      frames.set(t.id, rec)
      c.ws.on('error', () => {})
    }
    for (const [tid, rec] of frames) {
      // an unmounted iframe: its data went with it — never wait on its socket
      if (!alive.has(tid)) { if (!rec.gone) { rec.gone = true; rec.conn.close() } continue }
      // a page still booting may not answer yet — keep trying until it does
      if (!rec.probed) rec.conn.evaluate(PROBE).then((v) => { if (v) rec.probed = true }).catch(() => {})
      const o = await rec.conn.evaluate(TAKE).catch(() => null)
      if (o) { rec.raf.push(...o.raf); rec.drawn.push(...o.drawn) }
      else rec.probed = false // installed into a document that was then replaced
    }
    await new Promise((r) => setTimeout(r, 300))
  }
}
const poller = poll()
await new Promise((r) => setTimeout(r, 600))
const t0 = Date.now()
await ed.evaluate(`${S}.setPlaying(true), 0`)
await new Promise((r) => setTimeout(r, (to - from) * 1000))
await ed.evaluate(`${S}.setPlaying(false), 0`)
await new Promise((r) => setTimeout(r, 700))
stop = true
await poller
const edF = await ed.evaluate(`(() => { const f = window.__benchEd.f; window.__benchEd = null; return f })()`)
await ed.evaluate(`${S}.setPlayhead(${saved}), 0`)

// ------------------------------------------------------------------ report
const play = edF.filter(([w]) => w >= t0)
const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i])
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0 }
const edGaps = gaps(play.map(([w]) => w))
const dur = (play.at(-1)[0] - play[0][0]) / 1000
console.log(`\neditor: ${(play.length / dur).toFixed(1)} fps, p95 ${q(edGaps, 0.95).toFixed(1)} ms, worst ${Math.max(...edGaps).toFixed(0)} ms`)

// the clip visible at a wall time = the one under the playhead
const at = (wall) => { let lo = 0, hi = play.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (play[m][0] <= wall) lo = m; else hi = m - 1 } return play[lo][1] }
const visible = (wall, frag) => { const ph = at(wall); return project.clips.some((c) => c.frag === frag && ph >= c.start && ph < c.end) }
for (const rec of frames.values()) {
  const drawnVis = rec.drawn.filter((w) => w >= t0 && visible(w, rec.comp))
  const rafAll = rec.raf.filter((w) => w >= t0)
  const drawnAll = rec.drawn.filter((w) => w >= t0)
  const g = gaps(drawnVis)
  const visDur = play.filter(([w, ph]) => project.clips.some((c) => c.frag === rec.comp && ph >= c.start && ph < c.end)).length / (play.length / dur)
  const big = g.map((x, i) => [x, drawnVis[i]]).filter(([x]) => x > 150).map(([x, w]) => `${x.toFixed(0)}ms@${at(w).toFixed(2)}s`)
  console.log(`iframe ${rec.comp.padEnd(20)} raf ${(rafAll.length / dur).toFixed(0).padStart(3)}/s  gl-frames ${(drawnAll.length / dur).toFixed(0).padStart(3)}/s  ` +
    `while visible: ${visDur > 0.05 ? `${(drawnVis.length / visDur).toFixed(1)} fps, worst gap ${g.length ? Math.max(...g).toFixed(0) : '-'} ms` : '—'}${big.length ? '  stalls: ' + big.join(', ') : ''}`)
}
// per cut: worst editor gap and worst drawn-frame gap of the visible fragment, ±1.5 s
const cuts = project.clips.map((c) => c.start).filter((s) => s > from + 0.2 && s < to - 0.2)
for (const cut of cuts) {
  const near = play.filter(([, ph]) => Math.abs(ph - cut) < 1.5)
  if (near.length < 2) continue
  const w0 = near[0][0], w1 = near.at(-1)[0]
  const eg = gaps(near.map(([w]) => w))
  let worst = 0
  const where = []
  for (const rec of frames.values()) {
    const d = rec.drawn.filter((w) => w >= w0 && w <= w1 && visible(w, rec.comp))
    gaps(d).forEach((x, i) => {
      worst = Math.max(worst, x)
      if (x > 60) where.push(`${rec.comp.split('-')[0]} ${x.toFixed(0)}ms@${((d[i] - (near.find(([, ph]) => ph >= cut)?.[0] ?? 0)) / 1000).toFixed(2)}s`)
    })
  }
  // time from the cut until the incoming fragment first drew while visible
  const inc = project.clips.find((c) => Math.abs(c.start - cut) < 1e-6)
  const wCut = near.find(([, ph]) => ph >= cut)?.[0]
  let first = null
  for (const rec of frames.values()) {
    if (rec.comp !== inc?.frag) continue
    const d = rec.drawn.find((w) => w >= wCut)
    if (d != null) first = first == null ? d - wCut : Math.min(first, d - wCut)
  }
  console.log(`cut @${cut.toFixed(2)}: editor worst ${Math.max(...eg).toFixed(0)} ms, fragment worst gap ${worst.toFixed(0)} ms, incoming first draw after ${first == null ? 'never' : first.toFixed(0) + ' ms'}${where.length ? '\n    gaps >60ms (rel. to cut): ' + where.join(', ') : ''}`)
}
for (const rec of frames.values()) if (!rec.gone) rec.conn.close()
ed.close()
process.exit(0)
