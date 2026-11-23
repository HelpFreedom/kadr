import { app, ipcMain, type BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { dirname, isAbsolute, join } from 'path'
import type { IPty } from 'node-pty'
import { startBridge, type EditorBridge } from './agentBridge'
import { codexSkillInstructions } from './codexSkills'
import { criticNewSession } from './critic'

interface Command {
  executable: string
  args: string[]
}

interface Session {
  pty: IPty
  bridge: EditorBridge
  win: BrowserWindow
  onWindowClosed: () => void
}

const KADR_INSTRUCTIONS =
  'You are embedded in Kadr, a video editor. The kadr MCP server is connected to ' +
  'the live project in the editor. Read the current timeline with kadr_state, edit ' +
  'through the Kadr tools, and verify the result in the editor. Treat requests as ' +
  'about the open project unless the user specifies otherwise. Ask before exporting ' +
  'unless the user has already requested an export.'

function resolveExecutable(name: string): Promise<string | undefined> {
  const windows = process.platform === 'win32'
  return new Promise((resolve) => {
    const command = windows ? 'where.exe' : '/bin/sh'
    const args = windows ? [name] : ['-c', 'command -v "$1"', 'sh', name]
    execFile(command, args, { windowsHide: true }, (error, stdout) => {
      const path = stdout.trim().split(/\r?\n/)[0]
      resolve(!error && isAbsolute(path) ? path : undefined)
    })
  })
}

async function resolveCodex(node: string): Promise<Command | undefined> {
  const windows = process.platform === 'win32'
  const executable = await resolveExecutable(windows ? 'codex.exe' : 'codex')
  if (executable) return { executable, args: [] }
  if (!windows) return undefined
  // Run the official npm launcher directly so cmd.exe never interprets
  // the TOML arguments or any spaces in the installation path.
  const shim = await resolveExecutable('codex.cmd')
  if (shim) {
    const script = join(dirname(shim), 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    if ((await fs.stat(script).catch(() => undefined))?.isFile()) {
      return { executable: node, args: [script] }
    }
  }
}

async function workspace(cwd: string | null): Promise<string> {
  if (cwd && isAbsolute(cwd) && (await fs.stat(cwd).catch(() => undefined))?.isDirectory()) return cwd
  const scratch = join(app.getPath('userData'), 'codex-workspace')
  await fs.mkdir(scratch, { recursive: true })
  return scratch
}

function codexArgs(node: string): string[] {
  const appPath = app.getAppPath()
  const script = join(appPath, 'electron', 'mcp-bridge.cjs')
  // Keep the bridge credentials in the session environment. Passing them
  // as TOML arguments would expose them in the CLI's command line.
  const server = 'mcp_servers.kadr={ command = ' + JSON.stringify(node) +
    ', args = [' + JSON.stringify(script) + ']' +
    ', env_vars = ["KADR_MCP_PORT", "KADR_MCP_TOKEN", "KADR_MCP_CRITIC_TOKEN", ' +
    '"KADR_CODEX_COMMAND", "KADR_CODEX_ENTRY", "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"], ' +
    'disabled_tools = ["kadr_review_begin", "kadr_review_frames", "kadr_review_submit"], tool_timeout_sec = 900 }'
  const hook = join(appPath, 'electron', 'claude-hook.cjs')
  const windows = process.platform === 'win32'
  const quote = (path: string) => windows
    ? '"' + path + '"'
    : "'" + path.replace(/'/g, "'\\''") + "'"
  // Codex's native /hooks review can trust this stable definition. The hook
  // receives the per-session credentials through its inherited environment.
  const hookCommand = quote(node) + ' ' + quote(hook)
  const onPrompt = 'hooks.UserPromptSubmit=[{hooks=[{type="command",command=' +
    JSON.stringify(hookCommand) + ',timeout=5}]}]'
  const instructions = KADR_INSTRUCTIONS + '\n\n' + codexSkillInstructions(appPath)
  return [
    '--no-daemon',
    '-c', server,
    '-c', onPrompt,
    '-c', 'developer_instructions=' + JSON.stringify(instructions)
  ]
}

function sessionEnv(bridge: EditorBridge, command: Command): Record<string, string | undefined> {
  const env = { ...process.env }
  // An editor launched from Codex should start a new terminal session.
  delete env.CODEX_THREAD_ID
  delete env.CODEX_SESSION_ID
  delete env.CODEX_TOOL_CALL_ID
  env.KADR_MCP_PORT = String(bridge.port)
  env.KADR_MCP_TOKEN = bridge.token
  delete env.KADR_MCP_CRITIC_TOKEN
  if (bridge.criticToken) env.KADR_MCP_CRITIC_TOKEN = bridge.criticToken
  env.KADR_CODEX_COMMAND = command.executable
  delete env.KADR_CODEX_ENTRY
  if (command.args[0]) env.KADR_CODEX_ENTRY = command.args[0]
  return env
}

function size(cols: number, rows: number): { cols: number; rows: number } {
  return {
    cols: Number.isInteger(cols) ? Math.max(20, cols) : 80,
    rows: Number.isInteger(rows) ? Math.max(5, rows) : 24
  }
}

function stopPty(pty: IPty) {
  if (process.platform === 'win32') {
    try { pty.kill() } catch { /* already exited */ }
    return
  }
  const pgid = -pty.pid
  try { process.kill(pgid, 'SIGHUP') } catch {
    try { pty.kill() } catch { /* already exited */ }
    return
  }
  setTimeout(() => {
    try { process.kill(pgid, 'SIGKILL') } catch { /* already exited */ }
  }, 1500).unref()
}

export function registerCodexIpc(getWin: () => BrowserWindow | null) {
  let session: Session | null = null
  let generation = 0

  function release(current: Session) {
    session = null
    current.win.removeListener('closed', current.onWindowClosed)
    current.bridge.close()
  }

  function close() {
    generation++
    if (!session) return
    const current = session
    release(current)
    stopPty(current.pty)
  }

  ipcMain.handle('codex:open', async (event, cols: number, rows: number, cwd: string | null) => {
    const win = getWin()
    if (!win || event.sender !== win.webContents) return { ok: false, error: 'no window' }

    close()
    const request = generation
    const isCurrent = () => request === generation && !win.isDestroyed()
    const cancelled = { ok: false, error: 'superseded' }
    let bridge: EditorBridge | undefined
    try {
      const node = await resolveExecutable(process.platform === 'win32' ? 'node.exe' : 'node')
      if (!node) return { ok: false, error: 'Node.js was not found in PATH.' }
      const command = await resolveCodex(node)
      if (!command) return { ok: false, error: 'Codex CLI was not found in PATH.' }
      const dir = await workspace(cwd)
      const args = [...command.args, ...codexArgs(node)]
      // Keep the native dependency lazy so a missing PTY does not break Kadr.
      const nodePty = await import('node-pty')
      if (!isCurrent()) return cancelled
      bridge = await startBridge(win, true)
      if (!isCurrent()) {
        bridge.close()
        return cancelled
      }

      const options = { name: 'xterm-256color', ...size(cols, rows), cwd: dir, env: sessionEnv(bridge, command) }
      // Leave the CLI in the foreground and clean up its process group if the
      // editor is hard-killed. ConPTY owns the process tree on Windows.
      const watchdog = `(while kill -0 ${process.pid} 2>/dev/null; do kill -0 "$$" 2>/dev/null || exit 0; sleep 3; done; ` +
        'kill -HUP -$$ 2>/dev/null; sleep 2; kill -9 -$$ 2>/dev/null) & exec "$0" "$@"'
      const pty = process.platform === 'win32'
        ? nodePty.spawn(command.executable, args, options)
        : nodePty.spawn('/bin/sh', ['-c', watchdog, command.executable, ...args], options)
      const current: Session = { pty, bridge, win, onWindowClosed: close }
      session = current
      criticNewSession()
      win.once('closed', current.onWindowClosed)
      pty.onData((data) => {
        if (session === current && !win.isDestroyed()) win.webContents.send('codex:data', data)
      })
      pty.onExit(({ exitCode }) => {
        if (session !== current) return
        release(current)
        if (!win.isDestroyed()) win.webContents.send('codex:exit', exitCode)
      })
      return { ok: true }
    } catch (error) {
      if (session && session.bridge === bridge) close()
      else bridge?.close()
      return { ok: false, error: String(error) }
    }
  })

  ipcMain.on('codex:input', (event, data: string) => {
    if (session?.win.webContents !== event.sender || typeof data !== 'string') return
    try { session.pty.write(data) } catch { /* already exited */ }
  })
  ipcMain.on('codex:resize', (event, cols: number, rows: number) => {
    if (session?.win.webContents !== event.sender) return
    const fit = size(cols, rows)
    try { session.pty.resize(fit.cols, fit.rows) } catch { /* already exited */ }
  })
  ipcMain.handle('codex:close', (event) => {
    if (getWin()?.webContents === event.sender) close()
  })
  app.on('before-quit', close)
}
