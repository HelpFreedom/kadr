// Embedded Claude Code session: a PTY running the user's `claude` CLI inside
// the editor's terminal panel, wired to the live project through a local
// HTTP bridge (main ⇄ renderer eval) that the MCP stdio server
// (mcp-bridge.cjs, spawned by claude itself) talks to.
import { app, BrowserWindow, ipcMain } from 'electron'
import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import { constants as fsConstants, promises as fs } from 'fs'
import { delimiter, extname, join } from 'path'
import { homedir, tmpdir } from 'os'
import type { IPty } from 'node-pty'

const WIN = process.platform === 'win32'

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

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || (WIN && p.startsWith('~\\'))
    ? join(homedir(), p.slice(2))
    : p
}

/** the value of an environment variable, by Windows' rules if need be (names are case-insensitive there) */
function envVar(env: Record<string, string>, name: string): string | undefined {
  if (!WIN) return env[name]
  const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}

/**
 * Where the CLI is. Resolved here rather than by asking a shell: there is no
 * /bin/sh on Windows, and the shell never knew more than we do — a
 * non-interactive sh reads no rc file, so its PATH was ours.
 *
 * A name with a separator is a path (`~` expanded). A bare name is walked
 * along the session's PATH — the user may have extended it in claude-env.json
 * precisely so that claude is found — with PATHEXT on Windows, which is how
 * every installer's launcher turns up: npm's `claude.cmd` shim, the native
 * installer's `claude.exe`, bun/pnpm/volta shims. (CreateProcess alone would
 * try `.exe` and nothing else, and `where claude` lists npm's extensionless
 * sh-script shim first — a file ConPTY cannot start.) Then ~/.local/bin, the
 * native installer's directory on every platform, for an editor launched
 * from a desktop entry whose PATH has not caught up with the install.
 */
async function resolveCommand(
  cmd: string,
  env: Record<string, string>
): Promise<string | null> {
  const exts = WIN
    ? (envVar(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : []
  const runnable = async (p: string): Promise<string | null> => {
    if (WIN) {
      // a name with a known extension is taken as is; anything else gets one
      const ownExt = extname(p).toUpperCase()
      const tries = exts.some((e) => e.toUpperCase() === ownExt) ? [p] : exts.map((e) => p + e)
      for (const t of tries) if (await isFile(t)) return t
      return null
    }
    try {
      await fs.access(p, fsConstants.X_OK)
      return (await isFile(p)) ? p : null
    } catch {
      return null
    }
  }
  const name = expandHome(cmd)
  if (/[\\/]/.test(name)) return runnable(name)
  const dirs = (envVar(env, 'PATH') ?? '').split(delimiter).filter(Boolean)
  dirs.push(join(homedir(), '.local', 'bin'))
  for (const dir of dirs) {
    const hit = await runnable(join(dir, name))
    if (hit) return hit
  }
  return null
}

/** One argument quoted by the MSVCRT rules every CreateProcess-started program parses by. */
function quoteArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  return '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

/**
 * How the launcher is started on Windows. An `.exe` takes the arguments as
 * they are. A `.cmd`/`.bat` — npm's shim — needs cmd.exe. CreateProcess
 * would supply one by itself, but the explicit route is worth having:
 * `/d` keeps the registry's AutoRun (clink, conda hooks) from running and
 * printing into the panel, and the quoting is ours to get right. `/s` plus
 * an outer pair of quotes is what keeps a launcher path with a space in it
 * (`C:\Users\Jane Doe\AppData\Roaming\npm\claude.cmd`) in one piece: cmd
 * strips the first and the last quote of its command when the first
 * character is one, so a bare `/c "shim" args` loses the quotes around the
 * path and stops at `C:\Users\Jane`. Verified with a shim in a directory
 * with a space, both routes, inner quotes and non-ASCII arriving intact.
 */
function winLaunch(
  bin: string,
  args: string[],
  env: Record<string, string>
): [file: string, args: string | string[]] {
  if (!/\.(cmd|bat)$/i.test(bin)) return [bin, args]
  const line = [bin, ...args].map(quoteArg).join(' ')
  return [envVar(env, 'ComSpec') ?? 'cmd.exe', `/d /s /c "${line}"`]
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
  for (const [key, value] of Object.entries(extra ?? {})) {
    // Windows variable names are case-insensitive: a `PATH` override next to
    // the inherited `Path` would hand CreateProcess two spellings of one
    // variable, and which of them the child sees is not defined
    if (WIN) {
      const clash = Object.keys(env).find((k) => k !== key && k.toLowerCase() === key.toLowerCase())
      if (clash) delete env[clash]
    }
    env[key] = value
  }
  return env
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
  cwd: string | null
): Promise<{ ok: boolean; port?: number; error?: string }> {
  killSession() // a reopen without a close in between
  const cfg = await userConfig()
  const env = sessionEnv(cfg.env)
  const cmdName = process.env.KADR_CLAUDE_CMD || cfg.command || 'claude'
  const bin = await resolveCommand(cmdName, env)
  if (!bin) {
    return {
      ok: false,
      error:
        `"${cmdName}" not found on PATH (nor in ~/.local/bin) — install the Claude Code CLI, ` +
        `or set "command" in ${join(app.getPath('userData'), 'claude-env.json')}`
    }
  }

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
    // On Windows the console itself is the watchdog. The pseudoconsole is a
    // handle of THIS process: when it dies, however hard, the console host
    // goes with it and every process attached to that console receives
    // CTRL_CLOSE_EVENT and is terminated — claude and the MCP children it
    // spawned alike. So the launcher is started directly, no wrapper.
    // Mind the launcher: a `.cmd` (npm's shim) goes through cmd.exe (see
    // winLaunch), whose parser rewrites `%VAR%`, `^` and unquoted `& | < >`
    // on the way. The built-in args carry none of those; keep it so, and on
    // Windows keep any `args` override in claude-env.json equally plain —
    // or point `command` at the `.exe` the shim wraps.
    const p = WIN
      ? pty.spawn(...winLaunch(bin, args, env), {
          cols: Math.max(20, cols),
          rows: Math.max(5, rows),
          cwd: dir,
          env
        })
      : pty.spawn('/bin/bash', ['-c', wrapper, bin, ...args], {
          name: 'xterm-256color',
          cols: Math.max(20, cols),
          rows: Math.max(5, rows),
          cwd: dir,
          env
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
    return { ok: true, port: bridge.port }
  } catch (err) {
    bridge.server.close()
    return { ok: false, error: String(err) }
  }
}

function killSession() {
  if (!session) return
  const s = session
  session = null
  if (WIN) {
    // node-pty's ConPTY kill enumerates the console's process list and
    // terminates every member (claude + its MCP server children), then
    // closes the pseudoconsole; there are no process groups to signal
    try { s.pty.kill() } catch { /* dead */ }
  } else {
    // HUP the whole process group (claude + its MCP server children), then
    // escalate: a busy tree that shrugs off SIGHUP must not outlive the panel
    const pid = s.pty.pid
    try { process.kill(-pid, 'SIGHUP') } catch { try { s.pty.kill() } catch { /* dead */ } }
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ }
    }, 1500)
  }
  s.server.close()
}

/**
 * Open and close run ONE AT A TIME, and every request takes a generation.
 *
 * `spawnSession` is async (config read, `resolveCommand`, the node-pty import) while a
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
  cwd: string | null
): Promise<{ ok: boolean; port?: number; error?: string }> {
  const gen = ++sessionGen
  const job = sessionChain.then(() =>
    gen === sessionGen
      ? spawnSession(win, cols, rows, cwd)
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
