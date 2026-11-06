// Test: the critic subagent, end to end, with no API call.
//
// The embedded session's command is replaced by a stand-in that records the
// argv Kadr gives it, so the suite checks what the REAL claude would receive:
//   * --agents carries kadr-critic, whose tools can only look (no kadr_eval, no
//     file writes, no shell) — it must not be able to change the project;
//   * --settings carries the UserPromptSubmit hook, and that hook, run as the
//     CLI runs it, opens a turn for a user's prompt and NOT for a
//     <task-notification> (the CLI submits one when a background agent ends —
//     counted, every finished critic would reset its own limit);
// then drives the critic's tools through the real MCP bridge from the
// generated --mcp-config: a review (Kadr's own frames: cuts from both sides,
// the first seconds, the poster, a declared caption and event, the sound next
// to the event), a verification, and the refusal of a third round — which
// survives a reload of the page (the ledger lives in main) and lifts only for
// the user's next message. The report and its sheets land in kadr-reviews/,
// and the «Проверка» dialog lists the findings with a click to each.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// Replaces the open project, so it refuses over one with clips unless
// KADR_E2E_FORCE=1. Restores claude-env.json (user data — see CLAUDE.md).
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, chmodSync } from 'fs'
import { execFileSync } from 'child_process'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e53'
const ENV_FILE = `${process.env.HOME}/.config/kadr/claude-env.json`

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
async function pageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const p = (await targets()).find((t) => t.type === 'page' && t.title === 'Kadr')
      if (p) return p.webSocketDebuggerUrl
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('editor page not found')
}

function connect(url) {
  const sock = new WebSocket(url, { perMessageDeflate: false })
  const ready = new Promise((r, j) => { sock.on('open', r); sock.on('error', j) })
  ready.catch(() => {})
  let id = 0
  const send = async (method, params = {}) => {
    await ready
    return new Promise((resolve, reject) => {
      const m = ++id
      const on = (raw) => { const x = JSON.parse(raw); if (x.id !== m) return; sock.off('message', on); x.error ? reject(new Error(JSON.stringify(x.error))) : resolve(x.result) }
      sock.on('message', on)
      sock.send(JSON.stringify({ id: m, method, params }))
    })
  }
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  return { send, ev, close: () => { try { sock.close() } catch { /* not open */ } } }
}
let ed = connect(await pageWs())
// park results in a global and poll (awaitPromise is flaky under GC)
const evalJs = async (expression, timeout = 300000) => {
  const key = `k${Date.now()}_${Math.random().toString(36).slice(2)}`
  await ed.ev(`window.__e2e = window.__e2e || {}; (async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) } catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`)
  const t0 = Date.now()
  for (;;) {
    const raw = await ed.ev(`window.__e2e.${key} ?? null`)
    if (raw !== null) { const r = JSON.parse(raw); if ('err' in r) throw new Error(r.err); return r.ok }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 200))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const S = 'window.kadrEditor.useEditor.getState()'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const clipsOpen = await ed.ev(`${S}.project.tracks.reduce((n, t) => n + t.clips.length, 0)`)
if (clipsOpen > 0 && !process.env.KADR_E2E_FORCE) {
  console.log(`SKIP  e2e53 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

// a caption at composition 0.5–2.5 s and a big event at 1.0 s; the clip starts
// at 1 s, so on the timeline: the caption 1.5–3.5 (settled at 2.5), the event 2.0
const FRAG = `import React from 'react'
import { AbsoluteFill } from 'remotion'
import meta from './meta.json'
const F: React.FC = () => (
  <AbsoluteFill>
    <div style={{ position: 'absolute', left: 20, top: 20, color: '#ffffff', fontSize: 28, fontWeight: 900 }}>ПРОВЕРКА</div>
  </AbsoluteFill>
)
export const fragment = {
  component: F, meta,
  inspect: {
    events: [{ t: 1.0, kind: 'big' as const, label: 'удар' }],
    texts: [{ from: 0.5, to: 2.5, text: 'ПРОВЕРКА', role: 'title' as const }]
  }
}
`
const FAKE = `#!/bin/sh
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${DIR}/argv.json" "$@"
exec sleep 600
`
const NOTE = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<result>ok</result>\n</task-notification>'

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
writeFileSync(`${DIR}/fake-claude`, FAKE)
chmodSync(`${DIR}/fake-claude`, 0o755)
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args])
ff(['-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-pix_fmt', 'yuv420p', `${DIR}/a.mp4`])
ff(['-f', 'lavfi', '-i', 'color=c=0x2040ff:s=320x180:r=30:d=3', '-pix_fmt', 'yuv420p', `${DIR}/b.mp4`])
ff(['-f', 'lavfi', '-i', 'sine=f=1000:d=0.15', '-ar', '48000', `${DIR}/beep.wav`])

let envBackup = null
try { envBackup = readFileSync(ENV_FILE, 'utf8') } catch { /* none */ }
// a leftover stand-in from a crashed run is not user config
if (envBackup && JSON.parse(envBackup).command?.startsWith(DIR)) envBackup = null
let fragId = null
let mcp = null
try {
  // ---------------------------------------------------------------- the project
  const setup = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e53', width: 320, height: 180, fps: 30, background: '#000000',
      tracks: [mk('V1', 'video'), mk('V2', 'video'), mk('A1', 'audio')], assets: [], markers: [], texts: [] }, null)
    await window.kadr.writeProject('${DIR}/e2e53.kadr', st().project)
    st().setProjectPath('${DIR}/e2e53.kadr')
    const f = await E.createFragment({ name: 'e2e53-critic', start: 1, end: 5, transparent: true })
    const tracks = st().project.tracks
    const v = tracks.find((t) => t.kind === 'video' && !t.clips.length)
    await E.importFiles(['${DIR}/a.mp4', '${DIR}/b.mp4'], { trackId: v.id, at: 0 })
    const a = st().project.tracks.find((t) => t.kind === 'audio')
    await E.importFiles(['${DIR}/beep.wav'], { trackId: a.id, at: 2.08 })
    await window.kadr.writeProject('${DIR}/e2e53.kadr', st().project)
    return { id: f.id, entry: f.entry, clipId: f.clipId,
      clips: st().project.tracks.flatMap((t) => t.clips.map((c) => ({ kind: t.kind, start: c.start, duration: c.duration }))) }
  })()`)
  fragId = setup.id
  writeFileSync(setup.entry, FRAG)
  const vclips = setup.clips.filter((c) => c.kind === 'video')
  check('the test timeline: two footage clips cut at 3 s, a fragment 1–5 s, a beep at 2.08 s',
    vclips.some((c) => Math.abs(c.start - 3) < 1e-6) && vclips.some((c) => Math.abs(c.start - 1) < 1e-6) &&
    setup.clips.some((c) => c.kind === 'audio' && Math.abs(c.start - 2.08) < 1e-6), JSON.stringify(setup.clips))

  // ---------------------------------------------------------------- what claude is given
  writeFileSync(ENV_FILE, JSON.stringify({ command: `${DIR}/fake-claude` }))
  const opened = await evalJs(`window.kadr.claudeOpen(80, 24, '${DIR}')`)
  for (let i = 0; i < 40 && !existsSync(`${DIR}/argv.json`); i++) await sleep(250)
  check('the session starts', opened.ok === true && existsSync(`${DIR}/argv.json`), JSON.stringify(opened))
  const argv = JSON.parse(readFileSync(`${DIR}/argv.json`, 'utf8'))
  const flag = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

  const agents = JSON.parse(flag('--agents') ?? '{}')
  const critic = agents['kadr-critic']
  check('--agents defines kadr-critic, inheriting the session\'s model', !!critic && critic.model === 'inherit' && critic.prompt.length > 2000)
  const tools = critic?.tools ?? []
  check('the critic can only look: Read, its review tools, kadr_state, kadr_check',
    JSON.stringify([...tools].sort()) === JSON.stringify(['Read', 'mcp__kadr__kadr_check', 'mcp__kadr__kadr_review_begin',
      'mcp__kadr__kadr_review_frames', 'mcp__kadr__kadr_review_submit', 'mcp__kadr__kadr_state'].sort()), tools.join(','))
  check('… nothing that writes: no kadr_eval, Edit, Write, Bash, kadr_snapshot (it imports into the bin)',
    !tools.some((t) => /kadr_eval|^Edit$|^Write$|^Bash$|kadr_snapshot|kadr_export/.test(t)))
  check('the system prompt sends finished blocks to the critic', /kadr-critic/.test(flag('--append-system-prompt') ?? ''))
  const settings = JSON.parse(flag('--settings') ?? '{}')
  const hookCmd = settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command
  check('--settings carries the UserPromptSubmit hook', typeof hookCmd === 'string' && hookCmd.includes('claude-hook.cjs'), hookCmd)

  const ledger = () => evalJs('window.kadr.criticList()')
  const hook = (prompt) => execFileSync('sh', ['-c', hookCmd], { input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt }) }).toString()
  const t0 = (await ledger()).turn
  const out1 = hook(NOTE)
  check('the hook prints nothing (its stdout would join the conversation)', out1 === '')
  check('a <task-notification> prompt does NOT open a turn', (await ledger()).turn === t0)
  hook('Сделай заставку на 6 секунд')
  check('the user\'s prompt opens a turn', (await ledger()).turn === t0 + 1)

  // ---------------------------------------------------------------- the critic's tools over MCP
  const mcpCfg = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8')).mcpServers.kadr
  mcp = new Client({ name: 'e2e53', version: '1' })
  await mcp.connect(new StdioClientTransport({ command: mcpCfg.command, args: mcpCfg.args }))
  const names = (await mcp.listTools()).tools.map((t) => t.name)
  check('the bridge serves kadr_review_begin/frames/submit', ['kadr_review_begin', 'kadr_review_frames', 'kadr_review_submit'].every((n) => names.includes(n)))
  const call = async (name, args) => {
    const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 600000 })
    const text = r.content?.[0]?.text ?? ''
    if (r.isError) return { error: text }
    try { return JSON.parse(text) } catch { return { text } }
  }

  const b1 = await call('kadr_review_begin', { from: 0, to: 6 })
  check('round 1 is a review of 0–6', b1.mode === 'review' && b1.round === 1 && b1.range?.from === 0 && b1.range?.to === 6, JSON.stringify(b1).slice(0, 300))
  const plan = b1.plan ?? []
  const at = (t, re) => plan.some((f) => Math.abs(f.t - t) < 0.02 && re.test(f.why))
  check('Kadr picks the frames: both sides of the cut at 3 s', at(3 - 1 / 30, /перед склейкой/) && at(3, /после склейки/))
  check('… the first seconds and the poster', at(0.5, /крючок/) && at(2, /крючок|событие/) && at(6 - 1 / 30, /постер/))
  check('… the declared caption settled and the big event as it lands', at(2.5, /надпись «ПРОВЕРКА»/) && at(2.1, /событие «удар»/),
    plan.map((f) => `${f.t}:${f.why}`).join(' | '))
  check('the fragment clip is offered for kadr_check', b1.clipIds?.length === 1 && b1.clipIds[0] === setup.clipId)
  const ev = b1.sound?.events?.[0]
  check('the event is lined up with the beep under it: +80 ms', ev && ev.sound && Math.abs(ev.sound.deltaMs - 80) <= 1, JSON.stringify(b1.sound))

  const outside = await call('kadr_review_frames', { reviewId: b1.reviewId, times: [40, 50] })
  check('frames outside the range are not rendered', !!outside.error && /no frames/.test(outside.error))
  const f1 = await call('kadr_review_frames', { reviewId: b1.reviewId })
  const sheetPaths = (f1.sheets ?? []).map((s) => s.path)
  const rendered = (f1.sheets ?? []).reduce((n, s) => n + s.frames.length, 0)
  check('the plan renders into contact sheets in <projectDir>/kadr-reviews',
    rendered === plan.length && sheetPaths.length > 0 && sheetPaths.every((p) => p.startsWith(`${DIR}/kadr-reviews/`) && existsSync(p)),
    `${rendered}/${plan.length} frames, ${sheetPaths.join(', ')}`)
  check('… every frame carries the reason it was chosen', (f1.sheets ?? []).every((s) => s.frames.every((f) => typeof f.why === 'string' && f.why)))
  // 59 more frames than the plan: only what is left of the round's 60 renders
  const big = await call('kadr_review_frames', { reviewId: b1.reviewId, times: Array.from({ length: 59 }, (_, i) => 0.05 + i * 0.1), width: 320 })
  const bigN = (big.sheets ?? []).reduce((n, s) => n + s.frames.length, 0)
  check('a round renders at most 60 frames', bigN === 60 - plan.length && (big.notRendered ?? 0) === 59 - bigN, `${bigN} more, ${big.notRendered} refused`)
  const spent = await call('kadr_review_frames', { reviewId: b1.reviewId, times: [1] })
  check('… and then none', !!spent.error && /all the frames/.test(spent.error))

  const tooMany = await call('kadr_review_submit', { reviewId: b1.reviewId, defects: [1, 2, 3, 4].map((t) => ({ t, severity: 'high', what: 'w', evidence: 'e', fix: 'f' })) })
  check('four defects are refused', !!tooMany.error && /at most 3/.test(tooMany.error))
  const s1 = await call('kadr_review_submit', { reviewId: b1.reviewId, defects: [{
    t: 2.0, severity: 'high', what: 'надпись мелкая для телефона', evidence: 'кадр 0:02.50: буквы 28 px при высоте 180', fix: 'кегль 28 → 40 px' }] })
  check('the review answers with the defect and the NEXT step', /d1 · 0:02.00 · high/.test(s1.answer ?? '') && /repair ONLY/.test(s1.answer ?? ''), (s1.answer ?? s1.error ?? '').slice(0, 200))
  const reports = () => readdirSync(`${DIR}/kadr-reviews`).filter((f) => f.endsWith('.md'))
  check('a markdown report is written next to the project', reports().length === 1 &&
    /надпись мелкая/.test(readFileSync(`${DIR}/kadr-reviews/${reports()[0]}`, 'utf8')))

  const b2 = await call('kadr_review_begin', { from: 0.5, to: 5.5 })
  check('the next call on the stretch verifies (round 2, the original range, the prior defect)',
    b2.mode === 'verify' && b2.round === 2 && b2.range?.from === 0 && b2.prior?.[0]?.id === 'd1', JSON.stringify(b2).slice(0, 200))
  check('… and its frames are the defect\'s', (b2.plan ?? []).length >= 1 && b2.plan.every((f) => /d1/.test(f.why)))
  await call('kadr_review_frames', { reviewId: b2.reviewId })
  const newOnes = await call('kadr_review_submit', { reviewId: b2.reviewId, defects: [{ t: 4, severity: 'medium', what: 'w', evidence: 'e', fix: 'f' }] })
  check('a verification may not report new defects', !!newOnes.error)
  const s2 = await call('kadr_review_submit', { reviewId: b2.reviewId, verified: [{ id: 'd1', status: 'fixed', note: 'теперь 40 px' }] })
  check('the verification ends the critic\'s work on the stretch', /d1 · 0:02.00: fixed/.test(s2.answer ?? '') && /until the user/.test(s2.answer ?? ''), (s2.answer ?? s2.error ?? '').slice(0, 200))
  check('… one report per stretch, now with both rounds', reports().length === 1 &&
    /проверка правок/.test(readFileSync(`${DIR}/kadr-reviews/${reports()[0]}`, 'utf8')))

  const b3 = await call('kadr_review_begin', { from: 0, to: 6 })
  check('a third round is refused', b3.refused === true && b3.code === 'reviewed', JSON.stringify(b3))
  check('… so is a piece of the same stretch', (await call('kadr_review_begin', { from: 2, to: 3 })).refused === true)

  // ---------------------------------------------------------------- the dialog
  const ui = await evalJs(`(async () => {
    window.kadrEditor.useChecksUi.getState().setOpen(true)
    await new Promise((r) => setTimeout(r, 300))
    const chains = [...document.querySelectorAll('.critic-chain')]
    const btn = chains[0]?.querySelector('.checks-list button')
    btn?.click()
    await new Promise((r) => setTimeout(r, 100))
    const out = { chains: chains.length, text: chains[0]?.textContent ?? '', playhead: ${S}.playhead }
    window.kadrEditor.useChecksUi.getState().setOpen(false)
    return out
  })()`)
  check('«Проверка» lists the review with its defect and verdict', ui.chains === 1 && /надпись мелкая/.test(ui.text) && /исправлено/.test(ui.text), ui.text.slice(0, 160))
  check('… a click on the defect puts the playhead there', Math.abs(ui.playhead - 2) < 1e-6, String(ui.playhead))

  // ---------------------------------------------------------------- the limit outlives the page
  await ed.ev('location.reload()')
  ed.close()
  await sleep(3000)
  ed = connect(await pageWs())
  for (let i = 0; i < 60; i++) {
    if (await ed.ev('!!(window.kadrEditor && window.kadr)').catch(() => false)) break
    await sleep(500)
  }
  await evalJs(`(async () => { await window.kadrEditor.openProject('${DIR}/e2e53.kadr'); return 1 })()`)
  const b4 = await call('kadr_review_begin', { from: 0, to: 6 })
  check('a reload of the page does not reset the limit (the ledger is in main)', b4.refused === true, JSON.stringify(b4).slice(0, 160))
  hook(NOTE)
  check('… nor does a background agent finishing', (await call('kadr_review_begin', { from: 0, to: 6 })).refused === true)
  hook('Подними ещё надпись повыше')
  const b5 = await call('kadr_review_begin', { from: 0, to: 6 })
  check('the user\'s next message opens the stretch again (a fresh review)', b5.mode === 'review' && b5.round === 1 && b5.reviewId !== b1.reviewId)
  await call('kadr_review_submit', { reviewId: b5.reviewId, defects: [] })
} finally {
  if (process.env.KADR_E2E_KEEP) { ed.close(); process.exit() }
  try { await mcp?.close() } catch { /* gone */ }
  await evalJs('window.kadr.claudeClose()').catch(() => {})
  if (envBackup !== null) writeFileSync(ENV_FILE, envBackup)
  else rmSync(ENV_FILE, { force: true })
  if (fragId) await ed.ev(`window.kadr.fragmentDelete('${fragId}').then(() => 1, () => 0)`).catch(() => {})
  rmSync(DIR, { recursive: true, force: true })
  await ed.ev(`${S}.setProject({ version: 1, id: window.kadrEditor.uid(), name: 'Untitled', width: 1920, height: 1080, fps: 30, background: '#000000', tracks: [], assets: [], markers: [], texts: [] }, null)`).catch(() => {})
  ed.close()
}
