// Embedded Claude Code session: a PTY running the user's `claude` CLI inside
// the editor's terminal panel, wired to the live project through a local
// HTTP bridge (main ⇄ renderer eval) that the MCP stdio server
// (mcp-bridge.cjs, spawned by claude itself) talks to.
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer, type Server } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join, isAbsolute } from 'path'
import { tmpdir } from 'os'
import type { IPty } from 'node-pty'
import { ensureInStore, listChats } from './chats'

// The session inherits this process's environment MINUS the markers of any
// Claude session that launched the editor (see SESSION_MARKERS). Anything extra the
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
/** bumped by every open/close request; a spawn whose generation is stale is abandoned */
let sessionGen = 0
/** open/close are serialized through this chain — see openSession */
let sessionChain: Promise<unknown> = Promise.resolve()

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
    join(app.getPath('userData'), 'decoded'),
    join(app.getPath('userData'), 'fragment-renders'),
    join(app.getAppPath(), 'scripts', 'transcribe.py'),
    join(app.getAppPath(), 'scripts', 'ttsqc_run.py')
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

/**
 * Local bridge: POST /eval {code} from mcp-bridge.cjs into the renderer.
 *
 * /eval is arbitrary JS in the page, and the page holds window.kadr (file
 * writes, pty spawn) — so the socket needs a door, not just an address.
 * Anything running on this machine can reach 127.0.0.1, and a WEB PAGE can
 * too: a fetch() with a simple content type is sent cross-origin without the
 * browser asking permission first, and the reply being unreadable does not
 * stop the code from running. A fragment previewed from the workspace vite
 * server is such a page. Two cheap locks close that:
 *   • a per-session secret in a custom header — a custom header forces the
 *     browser to ask permission first (preflight), which this server answers
 *     with 404, so a page cannot even send the request;
 *   • rejecting anything that carries an Origin at all — only browsers set
 *     it, and the only legitimate client here is a node process.
 * The health check (GET /) stays open: mcp-bridge only needs *a* reply.
 */
function startBridge(
  win: BrowserWindow
): Promise<{ server: Server; port: number; token: string }> {
  const token = randomBytes(24).toString('hex')
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/eval') {
        res.writeHead(404).end()
        return
      }
      if (req.headers.origin !== undefined || req.headers['x-kadr-token'] !== token) {
        res.writeHead(403).end()
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
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port, token })
      else reject(new Error('bridge listen failed'))
    })
  })
}

const WIN = process.platform === 'win32'

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (WIN) {
      if (isAbsolute(cmd)) return resolve(cmd)
      // `where` also lists npm's extensionless sh shims, which CreateProcess
      // cannot run — keep the first hit with a runnable extension (claude.cmd)
      const exts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(Boolean)
      execFile('where', [cmd], (err, stdout) => {
        const hit = err ? undefined : stdout.split(/\r?\n/).find((p) => exts.some((e) => p.toLowerCase().endsWith(e)))
        resolve(hit || null)
      })
      return
    }
    execFile('/bin/sh', ['-c', `command -v ${cmd}`], (err, stdout) => {
      resolve(err ? null : stdout.trim() || null)
    })
  })
}

/**
 * Markers a Claude Code session puts in the environment of everything it
 * spawns. They have to go before the panel's own session starts.
 *
 * If the editor was launched FROM a Claude session — which is exactly what
 * happens when an agent starts it to test something — Electron inherits
 * `CLAUDE_CODE_CHILD_SESSION=1`, node-pty passes it on, and the panel's claude
 * decides it is a nested session: it prints «Transcript saving is off —
 * inherited CLAUDE_CODE_CHILD_SESSION marker» and keeps no history. The panel
 * is not a nested session, though. The user opens it by hand from the editor's
 * UI, and its transcripts are theirs to keep; that it happened to be started
 * through another session is an accident of process lineage, nothing more.
 *
 * The list is explicit on purpose. Dropping everything that matches CLAUDE_*
 * would also take configuration the user may legitimately set for their own
 * CLI (CLAUDE_CONFIG_DIR being the dangerous one — it decides where the
 * credentials live), and a panel that cannot authenticate is a far worse
 * failure than a missing transcript. A marker added by a future version simply
 * has to be added here as well.
 */
const SESSION_MARKERS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_BRIDGE_SESSION',
  'CLAUDE_PID',
  'CLAUDE_EFFORT'
]

/**
 * The environment the panel's session runs in: ours, minus the markers of the
 * session that happened to launch the editor, plus whatever the user put in
 * claude-env.json (their own overrides always win — including, if they ever
 * want one back, a marker).
 */
function sessionEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const key of SESSION_MARKERS) delete env[key]
  return { ...env, ...extra }
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

async function spawnSession(
  win: BrowserWindow,
  cols: number,
  rows: number,
  cwd: string | null,
  chatId: string | null
): Promise<{ ok: boolean; port?: number; chatId?: string; error?: string }> {
  await killSession() // a reopen without a close in between
  const cfg = await userConfig()
  const cmdName = process.env.KADR_CLAUDE_CMD || cfg.command || 'claude'
  const bin = (await which(cmdName)) ?? cmdName

  let bridge: { server: Server; port: number; token: string }
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
          args: [
            join(app.getAppPath(), 'electron', 'mcp-bridge.cjs'),
            String(bridge.port),
            bridge.token
          ]
        }
      }
    }, null, 1)
  )

  let dir = cwd || app.getPath('home')
  try { await fs.access(dir) } catch { dir = app.getPath('home') }
  // chats: electron/chats.ts; an args override may not run claude, so no chat flags
  const chat = cfg.args ? undefined : chatId ?? randomUUID()
  if (chat && chatId) await ensureInStore(chatId, dir)
  const args = cfg.args ?? [
    '--mcp-config', mcpCfgPath,
    '--append-system-prompt', SYSTEM_HINT,
    ...(chatId ? ['--resume', chatId] : ['--session-id', chat as string])
  ]

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
    // Windows has no bash and no process groups: claude runs directly and
    // killSession takes its tree with taskkill; a hard Electron death closes
    // the pseudoconsole, which ends everything attached to it.
    const p = pty.spawn(WIN ? bin : '/bin/bash', WIN ? args : ['-c', wrapper, bin, ...args], {
      name: 'xterm-256color',
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      cwd: dir,
      env: sessionEnv(cfg.env)
    })
    // publish BEFORE wiring the handlers: data emitted between spawn and the
    // assignment would otherwise be dropped by the identity guard below
    const mine: Session = { pty: p, server: bridge.server, port: bridge.port }
    session = mine
    // both handlers are keyed to THIS session: a pty that outlived its panel
    // (a kill that lost a race, say) must never paint into the live terminal
    p.onData((data) => {
      if (session === mine) win.webContents.send('claude:data', data)
    })
    p.onExit(({ exitCode }) => {
      // only announce deaths of the CURRENT session: deliberate closes
      // (panel toggle, StrictMode remount) drop `session` before killing
      if (session === mine) {
        win.webContents.send('claude:exit', exitCode)
        mine.server.close()
        session = null
      }
    })
    return { ok: true, port: bridge.port, chatId: chat }
  } catch (err) {
    bridge.server.close()
    return { ok: false, error: String(err) }
  }
}

function killSession(): Promise<void> {
  if (!session) return Promise.resolve()
  const s = session
  session = null
  // HUP the whole process group (claude + its MCP server children), then
  // escalate: a busy tree that shrugs off SIGHUP must not outlive the panel
  const pid = s.pty.pid
  if (WIN) {
    s.server.close()
    // the whole tree: the .cmd shim's cmd.exe → claude → its MCP servers.
    // Waited for: a resume of the same chat must not race its old writer.
    return new Promise((done) => execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => {
      try { s.pty.kill() } catch { /* dead */ }
      done()
    }))
  }
  try { process.kill(-pid, 'SIGHUP') } catch { try { s.pty.kill() } catch { /* dead */ } }
  setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
  }, 1500)
  s.server.close()
  return Promise.resolve()
}

/**
 * Open and close run ONE AT A TIME, and every request takes a generation.
 *
 * `spawnSession` is async (config read, `which`, the node-pty import) while a
 * close is instant, so a close that overtook an in-flight open used to find
 * `session` still null, do nothing, and let the pending spawn install itself
 * afterwards — an orphaned claude nobody could reach or kill. React StrictMode
 * turned that race into the norm: it mounts ClaudePanel twice in dev
 * (mount → cleanup → mount), so every panel open spawned two ptys, both
 * writing into the same 'claude:data' channel — two interleaved sessions in
 * one terminal (issue #11). A fast open→close leaked one the same way in any
 * build. Serializing fixes the leak; the generation also lets a spawn that has
 * already been superseded be skipped instead of started and killed.
 */
function openSession(
  win: BrowserWindow,
  cols: number,
  rows: number,
  cwd: string | null,
  chatId: string | null
): Promise<{ ok: boolean; port?: number; chatId?: string; error?: string }> {
  const gen = ++sessionGen
  const job = sessionChain.then(() =>
    gen === sessionGen
      ? spawnSession(win, cols, rows, cwd, chatId)
      : { ok: false, error: 'superseded' }
  )
  sessionChain = job.catch(() => undefined)
  return job
}

function closeSession(): Promise<void> {
  sessionGen++ // abandon anything still in flight
  const job = sessionChain.then(killSession)
  sessionChain = job.catch(() => undefined)
  return job
}

/**
 * Keep the kadr-editor agent skill fresh in the user's skills directory —
 * the embedded claude discovers it from ~/.claude/skills. Scoped by its
 * description to sessions where the kadr_* MCP tools exist, so it stays
 * dormant in unrelated claude sessions and never collides with a separately
 * installed remotion skill (different name, hands composition authoring off).
 */
async function syncSkill(): Promise<void> {
  try {
    const src = await fs.readFile(join(app.getAppPath(), 'electron', 'kadr-skill.md'), 'utf8')
    const dir = join(app.getPath('home'), '.claude', 'skills', 'kadr-editor')
    const dst = join(dir, 'SKILL.md')
    const cur = await fs.readFile(dst, 'utf8').catch(() => null)
    if (cur === src) return
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(dst, src)
  } catch (err) {
    console.warn('[claude] skill sync failed:', err)
  }
}

export function registerClaudeIpc(getWin: () => BrowserWindow | null) {
  void sweepStaleSessions() // leftovers from a hard-killed previous run
  void syncSkill()
  ipcMain.handle('claude:open', (_e, cols: number, rows: number, cwd: string | null, chatId?: string | null) => {
    const win = getWin()
    if (!win) return { ok: false, error: 'no window' }
    return openSession(win, cols, rows, cwd, chatId ?? null)
  })
  ipcMain.handle('claude:chats', (_e, ids: string[]) => listChats(ids))
  ipcMain.on('claude:input', (_e, data: string) => session?.pty.write(data))
  ipcMain.on('claude:resize', (_e, cols: number, rows: number) => {
    try { session?.pty.resize(Math.max(20, cols), Math.max(5, rows)) } catch { /* dying */ }
  })
  ipcMain.handle('claude:close', () => closeSession())
  app.on('before-quit', closeSession)
}
