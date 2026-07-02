// Embedded Claude Code session: a PTY running the user's `claude` CLI inside
// the editor's terminal panel, wired to the live project through a local
// HTTP bridge (main ⇄ renderer eval) that the MCP stdio server
// (mcp-bridge.cjs, spawned by claude itself) talks to.
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer, type Server } from 'http'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { IPty } from 'node-pty'

// The session inherits this process's environment. Anything extra the
// user's claude needs (proxies, custom PATH…) plus command/args overrides
// live in userData/claude-env.json: { "command": "...", "args": [...],
// "env": { "HTTPS_PROXY": "...", ... } }. If you proxy claude, exclude
// localhost (NO_PROXY) so the kadr MCP bridge is reached directly.
// Extra MCP servers for the embedded session only (media search, etc.) go in
// userData/claude-mcp.json: { "mcpServers": { name: { command, args, env } } } —
// merged into the generated --mcp-config; sessions outside the editor are
// unaffected ("kadr" itself wins on a name clash).

const SYSTEM_HINT =
  'You are embedded inside Kadr, a video editor, and were opened from its UI. ' +
  'The MCP server "kadr" is connected to the LIVE project the user is editing right now: ' +
  'kadr_state reads it, kadr_eval changes it, kadr_export renders it, kadr_transcribe does ' +
  'speech-to-text, kadr_fragment_create makes Remotion compositions (animations, dynamic ' +
  'captions, motion graphics) that live as clips on the timeline — after creating one, edit ' +
  'its TSX entry file directly: the user sees your changes live in the preview, no rendering. ' +
  'Treat user requests as being about this project unless told otherwise. ' +
  'Imported media file paths are in kadr_state assets — you may read those files ' +
  'directly; the system ffmpeg/ffprobe are available for media work. ' +
  'If other MCP tools can fetch or download media (stock search etc.), files they save ' +
  'can go straight into this project: import via kadr_eval (probeMedia → addAsset → ' +
  'insertClipFromAsset) or copy them into a fragment folder for use inside Remotion ' +
  'compositions.'

interface Session {
  pty: IPty
  server: Server
  port: number
}

let session: Session | null = null

/**
 * Kill leftovers of previous editor sessions: any process whose cmdline
 * references paths only Kadr-spawned helpers use — the embedded-claude
 * tree (generated kadr-mcp.json / mcp-bridge script) and export/proxy/
 * reverse/transcribe workers (ffmpeg on kadr temp or cache paths, the
 * whisper runner). All of them inherit Chromium's listening sockets —
 * a survivor of a hard close holds the CDP port and blocks the next
 * launch. Outside-editor processes never reference these paths.
 * (Running two editor instances at once is not supported: the second
 * sweeps the first's helpers.)
 */
export async function sweepStaleSessions(): Promise<number> {
  const marks = [
    join(app.getPath('userData'), 'kadr-mcp.json'),
    join(app.getAppPath(), 'electron', 'mcp-bridge.cjs'),
    join(tmpdir(), 'kadr-export'), // raw encoder + muxer temp files
    join(app.getPath('userData'), 'proxies'),
    join(app.getPath('userData'), 'reversed'),
    join(app.getPath('userData'), 'fragment-renders'),
    join(app.getAppPath(), 'scripts', 'transcribe.py')
  ]
  let entries: string[]
  try { entries = await fs.readdir('/proc') } catch { return 0 } // non-Linux
  const statOf = async (pid: number) => {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ') // state ppid pgrp …
    return { ppid: Number(f[1]), pgrp: Number(f[2]) }
  }
  // never touch ourselves, our ancestors (shell that launched us may mention
  // these paths in its cmdline), or anything sharing their process groups
  const safePids = new Set<number>()
  const safeGroups = new Set<number>()
  let cur = process.pid
  for (let i = 0; i < 20 && cur > 1; i++) {
    safePids.add(cur)
    try {
      const s = await statOf(cur)
      safeGroups.add(s.pgrp)
      cur = s.ppid
    } catch { break }
  }
  const groups = new Set<number>()
  for (const ent of entries) {
    if (!/^\d+$/.test(ent)) continue
    const pid = Number(ent)
    if (safePids.has(pid)) continue
    let cmd = ''
    try { cmd = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8') } catch { continue }
    if (!marks.some((m) => cmd.includes(m))) continue
    let pgid = pid
    try {
      const g = (await statOf(pid)).pgrp
      if (g > 1) pgid = g
    } catch { /* keep pid */ }
    if (safeGroups.has(pgid)) continue
    groups.add(pgid)
  }
  let killed = 0
  for (const g of groups) {
    try { process.kill(-g, 'SIGKILL'); killed++ } catch {
      try { process.kill(g, 'SIGKILL'); killed++ } catch { /* raced away */ }
    }
  }
  if (killed) console.log(`[claude] swept ${killed} stale session group(s)`)
  return killed
}

/** JS evaluated in the page (async function body) → JSON result. */
async function evalInPage(win: BrowserWindow, code: string): Promise<string> {
  const wrapped = `(async () => {
    try {
      const r = await (async () => { ${code}\n })()
      return JSON.stringify({ ok: r === undefined ? null : r })
    } catch (e) {
      return JSON.stringify({ error: String((e && (e.stack || e.message)) || e) })
    }
  })()`
  return win.webContents.executeJavaScript(wrapped, true)
}

/** Local bridge: POST /eval {code} from mcp-bridge.cjs into the renderer. */
function startBridge(win: BrowserWindow): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/eval') {
        res.writeHead(404).end()
        return
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', async () => {
        try {
          const { code } = JSON.parse(body)
          const out = await evalInPage(win, String(code))
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(out)
        } catch (err) {
          res
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: String(err) }))
        }
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port })
      else reject(new Error('bridge listen failed'))
    })
  })
}

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', `command -v ${cmd}`], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

interface ClaudeConfig {
  command?: string
  args?: string[]
  env?: Record<string, string>
}

async function userConfig(): Promise<ClaudeConfig> {
  try {
    const p = join(app.getPath('userData'), 'claude-env.json')
    return JSON.parse(await fs.readFile(p, 'utf8'))
  } catch {
    return {}
  }
}

async function openSession(
  win: BrowserWindow,
  cols: number,
  rows: number,
  cwd: string | null
): Promise<{ ok: boolean; port?: number; error?: string }> {
  if (session) closeSession()
  const cfg = await userConfig()
  const cmdName = process.env.KADR_CLAUDE_CMD || cfg.command || 'claude'
  const bin = (await which(cmdName)) ?? cmdName

  let bridge: { server: Server; port: number }
  try {
    bridge = await startBridge(win)
  } catch (err) {
    return { ok: false, error: `bridge: ${String(err)}` }
  }

  // per-session MCP config: claude merges it with the user's own servers
  let extraServers: Record<string, unknown> = {}
  try {
    const raw = await fs.readFile(join(app.getPath('userData'), 'claude-mcp.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed.mcpServers === 'object') extraServers = parsed.mcpServers
  } catch { /* optional file */ }
  const mcpCfgPath = join(app.getPath('userData'), 'kadr-mcp.json')
  await fs.writeFile(
    mcpCfgPath,
    JSON.stringify({
      mcpServers: {
        ...extraServers,
        kadr: {
          command: 'node',
          args: [join(app.getAppPath(), 'electron', 'mcp-bridge.cjs'), String(bridge.port)]
        }
      }
    }, null, 1)
  )

  const args = cfg.args ?? [
    '--mcp-config', mcpCfgPath,
    '--append-system-prompt', SYSTEM_HINT
  ]
  let dir = cwd || app.getPath('home')
  try { await fs.access(dir) } catch { dir = app.getPath('home') }

  try {
    // lazy import: node-pty is native — a load failure must not break the app
    const pty = await import('node-pty')
    // Watchdog wrapper: claude runs exec'd in the pty foreground (same pid
    // as the wrapper, TUI unaffected); a background subshell nukes the whole
    // process group if this Electron process dies hard — otherwise a busy
    // claude tree survives holding inherited Chromium sockets (CDP port)
    // and blocks the next launch.
    const wrapper =
      `(while kill -0 ${process.pid} 2>/dev/null; do sleep 3; done; ` +
      `kill -HUP -$$ 2>/dev/null; sleep 2; kill -9 -$$ 2>/dev/null) & exec "$0" "$@"`
    const p = pty.spawn('/bin/bash', ['-c', wrapper, bin, ...args], {
      name: 'xterm-256color',
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      cwd: dir,
      env: { ...process.env, ...cfg.env } as Record<string, string>
    })
    p.onData((data) => win.webContents.send('claude:data', data))
    p.onExit(({ exitCode }) => {
      // only announce deaths of the CURRENT session: deliberate closes
      // (panel toggle, StrictMode remount) null `session` before killing
      if (session?.pty === p) {
        win.webContents.send('claude:exit', exitCode)
        session.server.close()
        session = null
      }
    })
    session = { pty: p, server: bridge.server, port: bridge.port }
    return { ok: true, port: bridge.port }
  } catch (err) {
    bridge.server.close()
    return { ok: false, error: String(err) }
  }
}

function closeSession() {
  if (!session) return
  const s = session
  session = null
  // HUP the whole process group (claude + its MCP server children), then
  // escalate: a busy tree that shrugs off SIGHUP must not outlive the panel
  const pid = s.pty.pid
  try { process.kill(-pid, 'SIGHUP') } catch { try { s.pty.kill() } catch { /* dead */ } }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }, 1500)
  s.server.close()
}

export function registerClaudeIpc(getWin: () => BrowserWindow | null) {
  void sweepStaleSessions() // leftovers from a hard-killed previous run
  ipcMain.handle('claude:open', (_e, cols: number, rows: number, cwd: string | null) => {
    const win = getWin()
    if (!win) return { ok: false, error: 'no window' }
    return openSession(win, cols, rows, cwd)
  })
  ipcMain.on('claude:input', (_e, data: string) => session?.pty.write(data))
  ipcMain.on('claude:resize', (_e, cols: number, rows: number) => {
    try { session?.pty.resize(Math.max(20, cols), Math.max(5, rows)) } catch { /* dying */ }
  })
  ipcMain.handle('claude:close', () => closeSession())
  app.on('before-quit', closeSession)
}
