// Test: embedded Claude Code integration — PTY terminal session (with a
// safe `bash` override instead of the real claude), the editor HTTP bridge,
// and the MCP stdio server end-to-end (initialize → tools/list → kadr_state
// → kadr_eval mutation with undo entry).
import WebSocket from 'ws'
import { spawn } from 'child_process'
import { writeFileSync, unlinkSync, readFileSync } from 'fs'
import http from 'http'

const PORT = process.env.KADR_CDP_PORT || 9777
const ENV_FILE = `${process.env.HOME}/.config/kadr/claude-env.json`
const MCP_FILE = `${process.env.HOME}/.config/kadr/claude-mcp.json`
const GEN_FILE = `${process.env.HOME}/.config/kadr/kadr-mcp.json`

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

// safe override: the "claude" session is a plain interactive bash
let envBackup = null
try { envBackup = readFileSync(ENV_FILE, 'utf8') } catch { /* none */ }
writeFileSync(ENV_FILE, JSON.stringify({ command: 'bash', args: [] }))
// user MCP servers from claude-mcp.json must merge into the generated config
let mcpBackup = null
try { mcpBackup = readFileSync(MCP_FILE, 'utf8') } catch { /* none */ }
writeFileSync(MCP_FILE, JSON.stringify({
  mcpServers: { 'e2e-extra': { command: 'true', args: [] } }
}))

try {
  // give the page a name marker to read back through the bridges
  await evalJs(`(async () => {
    const st = window.kadrEditor.useEditor.getState()
    window.kadrEditor.useEditor.setState({ project: { ...st.project, name: 'mcp-test-project' } })
    return true
  })()`)

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
    gen.mcpServers.kadr.args?.[1] === String(opened.port),
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
  const mcpCall = (method, params) => new Promise((resolve, reject) => {
    const i = ++mcpId
    pending.set(i, resolve)
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(method + ' timeout')) } }, 20000)
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
  check('MCP exposes kadr tools',
    JSON.stringify(names) === JSON.stringify(
      ['kadr_eval', 'kadr_export', 'kadr_fragment_create', 'kadr_state', 'kadr_transcribe']),
    names.join(','))

  const state = await mcpCall('tools/call', { name: 'kadr_state', arguments: {} })
  const stText = state.result?.content?.[0]?.text ?? ''
  const stObj = JSON.parse(stText)
  check('kadr_state returns the live project',
    stObj.project?.name === 'mcp-test-project' && Array.isArray(stObj.exportPresets) && stObj.exportPresets.length > 0,
    `name=${stObj.project?.name}, presets=${stObj.exportPresets?.length}`)

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
  if (envBackup !== null) writeFileSync(ENV_FILE, envBackup)
  else try { unlinkSync(ENV_FILE) } catch { /* absent */ }
  if (mcpBackup !== null) writeFileSync(MCP_FILE, mcpBackup)
  else try { unlinkSync(MCP_FILE) } catch { /* absent */ }
}

ws.close()
console.log('e2e22 finished')
