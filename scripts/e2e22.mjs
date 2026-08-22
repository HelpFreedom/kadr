// Test: embedded Claude Code integration — PTY terminal session (with a
// safe `bash` override instead of the real claude), the editor HTTP bridge,
// and the MCP stdio server end-to-end (initialize → tools/list → capabilities
// → state → eval mutation with undo entry).
import WebSocket from 'ws'
import { spawn, execFileSync } from 'child_process'
import { writeFileSync, unlinkSync, readFileSync, statSync } from 'fs'
import http from 'http'

const PORT = process.env.KADR_CDP_PORT || 9777
const USER_DATA = process.env.KADR_USER_DATA || (process.platform === 'darwin'
  ? `${process.env.HOME}/Library/Application Support/kadr`
  : `${process.env.HOME}/.config/kadr`)
const ENV_FILE = `${USER_DATA}/claude-env.json`
const MCP_FILE = `${USER_DATA}/claude-mcp.json`
const GEN_FILE = `${USER_DATA}/kadr-mcp.json`

execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test && ' +
  'ffmpeg -v error -f lavfi -i "color=c=red:s=640x360:r=30:d=2" ' +
  '-c:v libx264 -pix_fmt yuv420p -y /tmp/kadr-test/agent-red.mp4 && ' +
  'ffmpeg -v error -f lavfi -i "color=c=blue:s=640x360:r=30:d=2" ' +
  '-c:v libx264 -pix_fmt yuv420p -y /tmp/kadr-test/agent-blue.mp4'])

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
  if (r.exceptionDetails) throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function evalJs(expression, { timeout = 120000 } = {}) {
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

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

let projectBackedUp = false
await evalJs(`(async () => {
  const store = window.kadrEditor.useEditor
  const s = store.getState()
  window.__mcpProjectBackup = {
    project: structuredClone(s.project), projectPath: s.projectPath,
    selection: [...s.selection], playhead: s.playhead, past: structuredClone(s.past),
    future: structuredClone(s.future), dirty: s.dirty
  }
  const project = structuredClone(s.project)
  project.id = 'mcp-agent-' + Date.now()
  project.name = 'mcp-test-project'
  project.assets = []
  project.texts = []
  project.tracks = project.tracks.map(t => ({ ...t, clips: [] }))
  store.setState({ project, projectPath: null, selection: [], playhead: 0,
    past: [], future: [], dirty: false })
  return true
})()`)
projectBackedUp = true

// safe override: the "claude" session is a plain interactive bash
let envBackup = null
try { envBackup = readFileSync(ENV_FILE, 'utf8') } catch { /* none */ }
// a leftover test override from a crashed run is NOT the user's config —
// restoring it would silently turn the user's Claude panel into plain bash
if (envBackup !== null && /"command"\s*:\s*"bash"/.test(envBackup)) envBackup = null
writeFileSync(ENV_FILE, JSON.stringify({ command: 'bash', args: [] }))
// user MCP servers from claude-mcp.json must merge into the generated config
let mcpBackup = null
try { mcpBackup = readFileSync(MCP_FILE, 'utf8') } catch { /* none */ }
if (mcpBackup !== null && mcpBackup.includes('e2e-extra')) mcpBackup = null
writeFileSync(MCP_FILE, JSON.stringify({
  mcpServers: { 'e2e-extra': { command: 'true', args: [] } }
}))

try {
  // 1) PTY session: open, type a command, see its output
  const opened = await evalJs(`(async () => {
    window.__cl = ''
    window.__clOff = window.kadr.onClaudeData((d) => { window.__cl += d })
    const r = await window.kadr.claudeOpen(100, 30, null)
    return r
  })()`)
  check('terminal session opens (bash override)', opened.ok === true && opened.port > 0,
    JSON.stringify(opened))

  // generated --mcp-config = user's extra servers + kadr (kadr wins clashes)
  const gen = JSON.parse(readFileSync(GEN_FILE, 'utf8'))
  check('claude-mcp.json servers merge into the generated mcp-config',
    !!gen.mcpServers['e2e-extra'] && !!gen.mcpServers.kadr &&
    gen.mcpServers.kadr.args?.[1] === String(opened.port) &&
    gen.mcpServers.kadr.command?.includes('Electron') &&
    gen.mcpServers.kadr.env?.ELECTRON_RUN_AS_NODE === '1',
    Object.keys(gen.mcpServers).join(','))

  const echoed = await evalJs(`(async () => {
    window.kadr.claudeInput('echo KADR_$((40+2))\\n')
    await new Promise(r => setTimeout(r, 1200))
    return window.__cl.includes('KADR_42')
  })()`)
  check('pty round-trip works (typed command echoes back)', echoed === true)

  // 2) editor HTTP bridge: eval from outside the page
  const bridged = await new Promise((resolve) => {
    const body = JSON.stringify({
      code: 'return window.kadrEditor.useEditor.getState().project.name'
    })
    const req = http.request(
      { host: '127.0.0.1', port: opened.port, path: '/eval', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => resolve(JSON.parse(data)))
      }
    )
    req.on('error', (e) => resolve({ error: e.message }))
    req.end(body)
  })
  check('editor HTTP bridge evaluates in the page', bridged.ok === 'mcp-test-project',
    JSON.stringify(bridged))

  // 3) MCP stdio server: handshake + tools + live state + mutation
  const mcp = spawn('node', ['electron/mcp-bridge.cjs', String(opened.port)],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  let buf = ''
  mcp.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch { /* partial */ }
    }
  })
  let mcpId = 0
  const mcpCall = (method, params, timeout = 20000) => new Promise((resolve, reject) => {
    const i = ++mcpId
    const timer = setTimeout(() => {
      if (pending.has(i)) { pending.delete(i); reject(new Error(method + ' timeout')) }
    }, timeout)
    pending.set(i, (message) => { clearTimeout(timer); resolve(message) })
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
  })

  const init = await mcpCall('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'e2e', version: '0' }
  })
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  check('MCP server initializes', init.result?.serverInfo?.name === 'kadr',
    JSON.stringify(init.result?.serverInfo))

  const tools = await mcpCall('tools/list', {})
  const names = (tools.result?.tools ?? []).map((t) => t.name).sort()
  const requiredTools = [
    'kadr_capabilities', 'kadr_eval', 'kadr_export', 'kadr_fragment_create',
    'kadr_snapshot', 'kadr_state', 'kadr_transcribe', 'kadr_voice_clone', 'kadr_voices'
  ]
  check('MCP exposes kadr tools',
    requiredTools.every((name) => names.includes(name)),
    names.join(','))

  const voices = await mcpCall('tools/call', { name: 'kadr_voices', arguments: {} })
  const voiceCatalog = JSON.parse(voices.result?.content?.[0]?.text ?? 'null')
  const bundledVoices = voiceCatalog.voices?.filter((voice) => !voice.custom) ?? []
  check('MCP reports the approved F5-TTS voices',
    voiceCatalog.engine === 'F5-TTS' && bundledVoices.length === 11 &&
    !bundledVoices.some((voice) => [5, 6, 11].includes(voice.number)),
    JSON.stringify(voiceCatalog))

  const caps = await mcpCall('tools/call', {
    name: 'kadr_capabilities', arguments: { section: 'transitions' }
  })
  const capsObj = JSON.parse(caps.result?.content?.[0]?.text ?? 'null')
  check('kadr_capabilities returns runtime transition registries',
    capsObj.section === 'transitions' &&
    capsObj.capabilities?.overlap?.effects?.length === 14 &&
    capsObj.capabilities?.edge?.effects?.length === 12 &&
    capsObj.capabilities.overlap.effects.some((x) => x.id === 'wipeRight') &&
    capsObj.capabilities.edge.effects.some((x) => x.id === 'lensWarp'),
    JSON.stringify({ overlap: capsObj.capabilities?.overlap?.effects?.length,
      edge: capsObj.capabilities?.edge?.effects?.length }))

  const allCaps = await mcpCall('tools/call', {
    name: 'kadr_capabilities', arguments: {}
  })
  const allCapsObj = JSON.parse(allCaps.result?.content?.[0]?.text ?? 'null')
  check('full capability contract covers every advertised feature section',
    allCapsObj.apiVersion === 2 && allCapsObj.availableSections.length === 14 &&
    allCapsObj.sections?.effects?.types?.map((x) => x.type).join(',') === 'blur,glow' &&
    allCapsObj.sections?.animation?.timeBases?.trackMotion.includes('absolute') &&
    allCapsObj.sections?.store?.availableActions?.includes('splitClipIntoRanges') &&
    allCapsObj.sections?.voice?.recording?.effects?.includes('compressor') &&
    allCapsObj.sections?.projectFiles?.portablePackage?.options?.includeDependencies,
    JSON.stringify({ sections: allCapsObj.availableSections?.length,
      actions: allCapsObj.sections?.store?.availableActions?.length }))

  const invalidCaps = await mcpCall('tools/call', {
    name: 'kadr_eval', arguments: {
      code: `return window.kadrEditor.getCapabilities('made-up-section')`
    }
  })
  check('unknown capability sections fail explicitly with valid alternatives',
    invalidCaps.result?.isError === true &&
    invalidCaps.result?.content?.[0]?.text?.includes('unknown capability section') &&
    invalidCaps.result?.content?.[0]?.text?.includes('projectFiles'),
    invalidCaps.result?.content?.[0]?.text ?? '')

  const state = await mcpCall('tools/call', { name: 'kadr_state', arguments: {} })
  const stText = state.result?.content?.[0]?.text ?? ''
  const stObj = JSON.parse(stText)
  check('kadr_state returns the live project',
    stObj.project?.name === 'mcp-test-project' && Array.isArray(stObj.exportPresets) && stObj.exportPresets.length > 0,
    `name=${stObj.project?.name}, presets=${stObj.exportPresets?.length}`)

  // Agent-style workflow: use only the contract + kadr_eval to import media,
  // build animation/masks/effects/transitions, then inspect state and pixels.
  const edit = await mcpCall('tools/call', {
    name: 'kadr_eval',
    arguments: { code:
      `const ed = window.kadrEditor; const st = () => ed.useEditor.getState()
       const v1 = st().project.tracks.find(t => t.kind === 'video')
       await ed.importFiles(['/tmp/kadr-test/agent-red.mp4', '/tmp/kadr-test/agent-blue.mp4'],
         { trackId: v1.id, at: 0 })
       let clips = [...st().project.tracks.find(t => t.id === v1.id).clips]
         .sort((a,b) => a.start - b.start)
       st().setClipStarts([{ id: clips[1].id, start: 1.5 }])
       clips = [...st().project.tracks.find(t => t.id === v1.id).clips]
         .sort((a,b) => a.start - b.start)
       const a = clips[0], b = clips[1]
       st().setTransition(b.id, 'wipeRight')
       st().setEdgeTransitions([{ clipId: a.id, edge: 'in', type: 'blurZoomIn', duration: 0.4 }])
       st().pushHistory('agent-feature-edit')
       st().updateClip(a.id, {
         transform: { ...a.transform,
           x: { value: 0, smooth: true, keyframes: [
             { time: 0, value: -120, easing: 'easeInOut' },
             { time: 1, value: 120, easing: 'easeOut' }] },
           scale: { value: 1, keyframes: [
             { time: 0, value: 0.72, easing: 'easeInOut' },
             { time: 1, value: 0.92, easing: 'easeOut' }] },
           rotation: { value: 0 }, opacity: { value: 1 },
           rotX: { value: 7 }, rotY: { value: -9 }, z: { value: 20 } },
         mask: { left: { value: 0.03 }, top: { value: 0.02 },
           right: { value: 0.03 }, bottom: { value: 0.02 } },
         maskShapes: [{ type: 'ellipse', cx: { value: 0.5 }, cy: { value: 0.5 },
           w: { value: 0.9 }, h: { value: 0.9 }, featherIn: { value: 0.02 },
           featherOut: { value: 0.06 }, invert: false }],
         effects: [
           { id: ed.uid(), type: 'blur', enabled: true, params: { size: 3 } },
           { id: ed.uid(), type: 'glow', enabled: true,
             params: { color: '#7fc4ff', size: 50, intensity: 0.7,
               saturation: 1, smoke: 0.3, speed: 1, particles: 0.2 } }]
       })
       const track = st().project.tracks.find(t => t.id === v1.id)
       st().updateTrack(v1.id, { motion: { ...track.motion,
         y: { value: 0, keyframes: [
           { time: 0, value: 0, easing: 'easeInOut' },
           { time: 2, value: 40, easing: 'easeOut' }] } } })
       const latestB = st().project.tracks.find(t => t.id === v1.id).clips.find(c => c.id === b.id)
       return { ids: [a.id,b.id], transition: latestB.transitionIn?.type,
         undo: st().past[st().past.length - 1]?.label }` }
  }, 120000)
  const editObj = JSON.parse(edit.result?.content?.[0]?.text ?? 'null')
  check('agent edits project through the public MCP/editor contract',
    editObj.ids?.length === 2 && editObj.transition === 'wipeRight' &&
    editObj.undo === 'agent-feature-edit', JSON.stringify(editObj))

  const editedState = await mcpCall('tools/call', { name: 'kadr_state', arguments: {} })
  const editedObj = JSON.parse(editedState.result?.content?.[0]?.text ?? 'null')
  const videoTrack = editedObj.project?.tracks?.find((t) => t.kind === 'video')
  const first = [...(videoTrack?.clips ?? [])].sort((a,b) => a.start - b.start)[0]
  const second = [...(videoTrack?.clips ?? [])].sort((a,b) => a.start - b.start)[1]
  check('state round-trip preserves keyframes, 3D, mask, effect stack and transition',
    first?.transform?.x?.keyframes?.length === 2 && first?.transform?.x?.smooth === true &&
    first?.transform?.rotX?.value === 7 && first?.maskShapes?.[0]?.type === 'ellipse' &&
    first?.effects?.map((x) => x.type).join(',') === 'blur,glow' &&
    second?.transitionIn?.type === 'wipeRight' && videoTrack?.motion?.y?.keyframes?.[1]?.time === 2,
    JSON.stringify({ effects: first?.effects?.map((x) => x.type),
      transition: second?.transitionIn?.type }))

  const packaged = await mcpCall('tools/call', {
    name: 'kadr_eval', arguments: { code:
      `const project = window.kadrEditor.useEditor.getState().project
       const result = await window.kadr.packageProject('/tmp/kadr-test', null, project,
         { includeDependencies: true, zip: true })
       const loaded = await window.kadr.readProject(result.projectPath)
       return { ...result, name: loaded.name, assets: loaded.assets.length,
         dependenciesInside: loaded.assets.every(a => a.path.startsWith(result.folderPath + '/')) }` }
  }, 120000)
  const packagedObj = JSON.parse(packaged.result?.content?.[0]?.text ?? 'null')
  let packageBytes = 0
  let zipBytes = 0
  try { packageBytes = statSync(packagedObj.projectPath).size } catch { /* failed below */ }
  try { zipBytes = statSync(packagedObj.zipPath).size } catch { /* failed below */ }
  check('agent can create and reopen a portable project package with dependencies',
    packagedObj.name === 'mcp-test-project' && packagedObj.assets === 2 &&
    packagedObj.dependenciesInside === true && packageBytes > 1000 && zipBytes > 1000,
    JSON.stringify({ project: packagedObj.projectPath, assets: packagedObj.assets,
      packageBytes, zipBytes }))

  const snap = await mcpCall('tools/call', {
    name: 'kadr_snapshot', arguments: { t: 0.75, importToBin: false }
  }, 120000)
  const snapObj = JSON.parse(snap.result?.content?.[0]?.text ?? 'null')
  let snapBytes = 0
  try { snapBytes = statSync(snapObj.path).size } catch { /* failed below */ }
  check('agent can visually verify a source-quality WYSIWYG snapshot',
    snapObj.path?.endsWith('.png') && snapBytes > 1000,
    JSON.stringify({ path: snapObj.path, bytes: snapBytes }))

  const exp = await mcpCall('tools/call', {
    name: 'kadr_export', arguments: { outputPath: '/tmp/kadr-test/agent-contract.mp4',
      presetId: 'hd720', start: 0, end: 1, motionBlur: false, frameBlending: false }
  }, 180000)
  const expObj = JSON.parse(exp.result?.content?.[0]?.text ?? 'null')
  let exportBytes = 0
  try { exportBytes = statSync('/tmp/kadr-test/agent-contract.mp4').size } catch { /* failed below */ }
  let exportProbe = ''
  try {
    exportProbe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x',
      '/tmp/kadr-test/agent-contract.mp4']).toString().trim()
  } catch { /* failed below */ }
  check('agent can export the edited timeline through MCP',
    expObj.written === '/tmp/kadr-test/agent-contract.mp4' &&
    expObj.preset === 'hd720' && exportBytes > 1000 && exportProbe === '1280x720',
    JSON.stringify({ result: expObj, bytes: exportBytes, probe: exportProbe }))

  const mut = await mcpCall('tools/call', {
    name: 'kadr_eval',
    arguments: { code:
      `const st = window.kadrEditor.useEditor.getState()
       st.addTrack('video')
       return window.kadrEditor.useEditor.getState().project.tracks.length` }
  })
  const tracksAfter = JSON.parse(mut.result?.content?.[0]?.text ?? 'null')
  const undoOk = await evalJs(`(async () => {
    const st = window.kadrEditor.useEditor.getState()
    const label = st.past[st.past.length - 1]?.label
    st.undo()
    return { label, tracks: window.kadrEditor.useEditor.getState().project.tracks.length }
  })()`)
  check('kadr_eval mutates the project with an undo entry',
    typeof tracksAfter === 'number' && !!undoOk.label && undoOk.tracks === tracksAfter - 1,
    JSON.stringify({ tracksAfter, ...undoOk }))

  mcp.kill()

  // 4) session teardown
  const closed = await evalJs(`(async () => {
    await window.kadr.claudeClose()
    window.__clOff()
    await new Promise(r => setTimeout(r, 300))
    return true
  })()`)
  const portDead = await new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: opened.port, path: '/eval', method: 'POST', timeout: 1500 },
      () => resolve(false)
    )
    req.on('error', () => resolve(true))
    req.on('timeout', () => { req.destroy(); resolve(true) })
    req.end('{}')
  })
  check('closing the session kills pty and bridge port', closed === true && portDead === true)
} finally {
  if (projectBackedUp) {
    try {
      await evalJs(`(async () => {
        const b = window.__mcpProjectBackup
        if (!b) return false
        window.kadrEditor.useEditor.setState({ project: b.project, projectPath: b.projectPath,
          selection: b.selection, playhead: b.playhead, past: b.past,
          future: b.future, dirty: b.dirty })
        delete window.__mcpProjectBackup
        return true
      })()`)
    } catch { /* app may already be closing */ }
  }
  try { await evalJs(`window.kadr.claudeClose()`) } catch { /* already closed */ }
  if (envBackup !== null) writeFileSync(ENV_FILE, envBackup)
  else try { unlinkSync(ENV_FILE) } catch { /* absent */ }
  if (mcpBackup !== null) writeFileSync(MCP_FILE, mcpBackup)
  else try { unlinkSync(MCP_FILE) } catch { /* absent */ }
}

ws.close()
console.log('e2e22 finished')
