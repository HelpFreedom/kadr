// Which Python runs faster-whisper. A bare `python3` used to be spawned, and on
// a stock Windows that name is the Microsoft Store stub («Python was not
// found»): transcription only worked where a launcher script put a venv on
// PATH. The candidates, in order: KADR_PYTHON (the setting, once there is a
// settings store), the app's own .venv, `py -3` (win32), python, python3 — and
// one is accepted only if it imports faster_whisper. Pure node, no electron:
// test `node scripts/check-python-resolve.mjs`.
import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

export interface PyCmd { command: string; args: string[] }
export type SpeechPython = (PyCmd & { device: 'cuda' | 'cpu' }) | { error: string }

interface Where { env: NodeJS.ProcessEnv; platform: NodeJS.Platform; appPath: string }

// ctranslate2 is faster_whisper's own engine: its device count is what
// scripts/transcribe.py will pick from
const PROBE = 'import faster_whisper, ctranslate2; print(ctranslate2.get_cuda_device_count())'
const PROBE_MS = 60000

export const pyLabel = (c: PyCmd) => [c.command, ...c.args].join(' ')

export function speechCandidates({ env, platform, appPath }: Where): PyCmd[] {
  const out: PyCmd[] = []
  const set = env.KADR_PYTHON?.trim()
  if (set) out.push({ command: set, args: [] })
  const venv = platform === 'win32'
    ? join(appPath, '.venv', 'Scripts', 'python.exe')
    : join(appPath, '.venv', 'bin', 'python')
  if (existsSync(venv)) out.push({ command: venv, args: [] })
  if (platform === 'win32') out.push({ command: 'py', args: ['-3'] })
  out.push({ command: 'python', args: [] }, { command: 'python3', args: [] })
  return out
}

function probe(c: PyCmd, env: NodeJS.ProcessEnv, code = PROBE): Promise<{ cuda: number } | { why: string }> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    const p = spawn(c.command, [...c.args, '-c', code], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => { p.kill(); err = `no answer in ${PROBE_MS / 1000} s` }, PROBE_MS)
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); resolve({ why: e.code || e.message }) })
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ cuda: parseInt(out.trim().split(/\r?\n/).pop() || '0', 10) || 0 })
      const last = err.trim().split(/\r?\n/).pop()
      resolve({ why: last || `exit ${code}` })
    })
  })
}

export async function resolveSpeechPython(where: Where): Promise<SpeechPython> {
  const tried: string[] = []
  for (const c of speechCandidates(where)) {
    const r = await probe(c, where.env)
    if ('cuda' in r) return { ...c, device: r.cuda > 0 ? 'cuda' : 'cpu' }
    tried.push(`${pyLabel(c)} (${r.why})`)
  }
  return { error: `no Python imports faster_whisper; tried: ${tried.join('; ')}` }
}

// The voice-over detector needs more than faster_whisper: python >= 3.11
// (tomllib) and torch. The speech interpreter (it imports faster_whisper) is
// taken only if it passes that probe; otherwise the old default `python3.11`.
const DETECTOR_PROBE = 'import sys, torch; assert sys.version_info >= (3, 11); print(0)'

export async function detectorPython(
  env: NodeJS.ProcessEnv, speech: () => Promise<SpeechPython>, dflt = 'python3.11'
): Promise<PyCmd> {
  const r = await speech()
  if (!('error' in r) && 'cuda' in await probe(r, env, DETECTOR_PROBE)) return { command: r.command, args: r.args }
  return { command: dflt, args: [] }
}
