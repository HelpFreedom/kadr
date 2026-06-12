// Embedded Claude Code session: a PTY running the user's `claude` CLI inside
// the editor's terminal panel, wired to the live project through a local
// HTTP bridge (main ⇄ renderer eval) that the MCP stdio server
// (mcp-bridge.cjs, spawned by claude itself) talks to.
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer, type Server } from 'http'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import type { IPty } from 'node-pty'

// The session inherits this process's environment. Anything extra the
// user's claude needs (proxies, custom PATH…) plus command/args overrides
// live in userData/claude-env.json: { "command": "...", "args": [...],
// "env": { "HTTPS_PROXY": "...", ... } }. If you proxy claude, exclude
// localhost (NO_PROXY) so the kadr MCP bridge is reached directly.

const SYSTEM_HINT =
  'You are embedded inside Kadr, a video editor, and were opened from its UI. ' +
  'The MCP server "kadr" is connected to the LIVE project the user is editing right now: ' +
  'kadr_state reads it, kadr_eval changes it, kadr_export renders it, kadr_transcribe does ' +
  'speech-to-text, kadr_fragment_create makes Remotion compositions (animations, dynamic ' +
  'captions, motion graphics) that live as clips on the timeline — after creating one, edit ' +
  'its TSX entry file directly: the user sees your changes live in the preview, no rendering. ' +
  'Treat user requests as being about this project unless told otherwise. ' +
  'Imported media file paths are in kadr_state assets — you may read those files ' +
  'directly; the system ffmpeg/ffprobe are available for media work.'

interface Session {
  pty: IPty
  server: Server
  port: number
}

let session: Session | null = null

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
  const mcpCfgPath = join(app.getPath('userData'), 'kadr-mcp.json')
  await fs.writeFile(
    mcpCfgPath,
    JSON.stringify({
      mcpServers: {
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
    const p = pty.spawn(bin, args, {
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
  try { s.pty.kill() } catch { /* already dead */ }
  s.server.close()
}

export function registerClaudeIpc(getWin: () => BrowserWindow | null) {
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
