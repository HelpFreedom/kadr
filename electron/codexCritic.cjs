const { spawn } = require('node:child_process')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createInterface } = require('node:readline')

const TOOLS = ['kadr_review_begin', 'kadr_review_frames', 'kadr_review_submit', 'kadr_state', 'kadr_check']
const TIMEOUT_MS = 12 * 60 * 1000

function criticArgs(instructions) {
  // The unattended worker can call only the review tools, with no approval
  // prompt to answer. The bridge separately enforces the reviewer credential.
  const server = 'mcp_servers.kadr={ command = ' + JSON.stringify(process.execPath) +
    ', args = [' + JSON.stringify(join(__dirname, 'mcp-bridge.cjs')) + ']' +
    ', env_vars = ["KADR_MCP_PORT", "KADR_MCP_TOKEN", "KADR_MCP_ROLE"]' +
    ', enabled_tools = ' + JSON.stringify(TOOLS) +
    ', default_tools_approval_mode = "approve", required = true, tool_timeout_sec = 480 }'
  return [
    '--no-daemon', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never',
    '--disable', 'shell_tool', '--disable', 'hooks', '--disable', 'plugins',
    '--disable', 'apps', '--disable', 'multi_agent_v2',
    '-c', 'web_search="disabled"', '-c', 'approval_policy="never"',
    '-c', 'project_doc_max_bytes=0', '-c', 'shell_environment_policy.inherit="none"',
    '-c', server, '-c', 'developer_instructions=' + JSON.stringify(instructions),
    '-'
  ]
}

function parseEvent(line) {
  try { return JSON.parse(line) } catch { return null }
}

function reviewAnswer(event) {
  const item = event?.item
  if (event?.type !== 'item.completed' || item?.type !== 'mcp_tool_call' ||
      item.server !== 'kadr' || item.status !== 'completed') return undefined

  if (item.tool !== 'kadr_review_begin' && item.tool !== 'kadr_review_submit') return undefined
  const block = item.result?.content?.find((part) => part.type === 'text')
  const result = item.result?.structured_content ?? parseEvent(block?.text)
  if (item.tool === 'kadr_review_submit' && typeof result?.answer === 'string') return result.answer
  if (result?.refused === true && typeof result.message === 'string') return result.message
}

function run(executable, args, options, prompt, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const child = spawn(executable, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let answer
    let failure
    let stderr = ''
    let timedOut = false
    let forceKill

    const stop = () => {
      child.kill()
      forceKill ??= setTimeout(() => child.kill('SIGKILL'), 3000)
    }
    const stopAtExit = () => child.kill('SIGKILL')
    process.once('exit', stopAtExit)
    signal?.addEventListener('abort', stop, { once: true })
    const timeout = setTimeout(() => {
      timedOut = true
      stop()
    }, TIMEOUT_MS)

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    lines.on('line', (line) => {
      // Review frames can be large image results. Only decode events we need.
      if (!line.includes('"kadr_review_begin"') && !line.includes('"kadr_review_submit"') &&
          !line.includes('"turn.failed"') && !line.startsWith('{"type":"error"')) return
      const event = parseEvent(line)
      answer ??= reviewAnswer(event)
      if (event?.type === 'turn.failed' || event?.type === 'error') {
        failure = event.error?.message ?? event.message ?? failure
      } else if (event?.type === 'item.completed' && event.item?.status === 'failed') {
        failure = event.item.error?.message ?? failure
      }
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
    child.stdin.on('error', () => { /* A startup failure is reported on child exit. */ })
    child.on('error', (error) => { failure = error.message })
    child.on('close', (code, terminationSignal) => {
      clearTimeout(timeout)
      clearTimeout(forceKill)
      process.removeListener('exit', stopAtExit)
      signal?.removeEventListener('abort', stop)
      lines.close()
      // Only a tool response can establish that the review was submitted or refused.
      if (answer) return resolve(answer)
      if (signal?.aborted) return reject(new Error('Codex critic review was cancelled.'))
      if (timedOut) return reject(new Error('Codex critic timed out before submitting the review.'))
      if (code === 0 && !failure) return reject(new Error('Codex critic ended without a review result.'))

      const reason = failure ?? stderr.trim()
      const detail = reason.replaceAll(options.env.KADR_MCP_TOKEN, '[redacted]').slice(-500)
      reject(new Error(`Codex critic exited (${terminationSignal ?? code})${detail ? `: ${detail}` : '.'}`))
    })
    child.stdin.end(prompt)
  })
}

/** Judge a range in a fresh Codex turn with access only to the review tools. */
async function runCodexCritic({ from, to, requirements, signal }) {
  const { KADR_CODEX_COMMAND: executable, KADR_CODEX_ENTRY: entry,
    KADR_MCP_CRITIC_TOKEN: token, KADR_MCP_PORT: port, ...inherited } = process.env
  if (!executable || !token || !port) throw new Error('Codex critic is unavailable in this session.')
  const env = { ...inherited, KADR_MCP_PORT: port, KADR_MCP_TOKEN: token, KADR_MCP_ROLE: 'critic' }
  // Do not inherit the author turn's identity.
  delete env.CODEX_THREAD_ID
  delete env.CODEX_SESSION_ID
  delete env.CODEX_TOOL_CALL_ID

  const source = await readFile(join(__dirname, 'agents', 'kadr-critic.md'), 'utf8')
  const instructions = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim() +
    '\n\nKadr supplies the contact sheets as images in the tool result. Inspect those images directly.'
  const prompt = `Review timeline seconds ${from} to ${to}.\n\nUser's verbatim requirements:\n${requirements || ''}`
  const cwd = await mkdtemp(join(tmpdir(), 'kadr-codex-critic-'))
  try {
    return await run(executable, [...(entry ? [entry] : []), ...criticArgs(instructions)], { cwd, env }, prompt, signal)
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = { runCodexCritic }
