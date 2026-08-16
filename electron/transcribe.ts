// Transcription backend: mix the requested audio to a temp wav (the same
// segment graph as exports — what you hear is what gets transcribed), then
// run faster-whisper via scripts/transcribe.py, streaming progress and live
// text to the renderer. One job at a time.
import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { ExportMuxer } from './ffmpeg'
import type { TranscribeRequest, TranscribeResult, TranscribeSegment } from '@shared/types'

let current: { muxer: ExportMuxer | null; py: ChildProcess | null; cancelled: boolean } | null = null

async function transcribePython(): Promise<string> {
  const configPath = join(homedir(), '.config', 'kadr', 'transcribe.json')
  try {
    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as { pythonPath?: string }
    return process.env.KADR_TRANSCRIBE_PYTHON || config.pythonPath || 'python3'
  } catch {
    return process.env.KADR_TRANSCRIBE_PYTHON || 'python3'
  }
}

async function run(win: BrowserWindow, req: TranscribeRequest): Promise<TranscribeResult> {
  if (current) throw new Error('transcription already running')
  const job = { muxer: null as ExportMuxer | null, py: null as ChildProcess | null, cancelled: false }
  current = job
  const wav = join(tmpdir(), `kadr-transcribe-${Date.now()}.wav`)
  const send = (progress: number, text: string) =>
    win.webContents.send('transcribe:progress', { progress, text })

  try {
    // 1) mixdown — ExportMuxer with an audio-only pcm preset writes a wav
    send(0.01, '')
    job.muxer = new ExportMuxer()
    await job.muxer.run(
      {
        projectName: 'transcribe',
        preset: {
          id: 'wav', name: 'wav', container: 'mp4', codec: '', ffmpegVideo: '',
          width: 0, height: 0, fps: 0, videoBitrate: 0,
          audioCodec: 'pcm_s16le', audioBitrate: '256k', audioOnly: true
        },
        outputPath: wav,
        width: 0, height: 0, fps: 0,
        duration: req.duration,
        audioSegments: req.audioSegments
      },
      '',
      () => { /* mix progress is fast; whisper dominates */ }
    )
    job.muxer = null
    if (job.cancelled) throw new Error('cancelled')

    // 2) whisper
    const segments: TranscribeSegment[] = []
    let language = req.language
    let liveText = ''
    const python = await transcribePython()
    await new Promise<void>((resolve, reject) => {
      const py = spawn(python, [
        join(app.getAppPath(), 'scripts', 'transcribe.py'),
        '--audio', wav,
        '--model', req.model,
        '--language', req.language,
        '--duration', String(req.duration)
      ], { stdio: ['ignore', 'pipe', 'pipe'] })
      job.py = py
      let buf = ''
      let err = ''
      py.stdout.on('data', (c) => {
        buf += c
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'segment') {
              segments.push({ start: msg.start, end: msg.end, text: msg.text, words: msg.words })
              liveText = msg.text
            } else if (msg.type === 'progress') {
              send(Math.min(0.99, msg.p), liveText)
            } else if (msg.type === 'done') {
              language = msg.language
            }
          } catch { /* partial line */ }
        }
      })
      py.stderr.on('data', (c) => { err += c })
      py.on('error', (error) => reject(new Error(
        `Не удалось запустить Python для транскрибации (${python}): ${error.message}. ` +
        'См. раздел «Локальная транскрибация» в README.md'
      )))
      py.on('close', (code) => {
        job.py = null
        if (job.cancelled) reject(new Error('cancelled'))
        else if (code === 0) resolve()
        else if (err.includes("No module named 'faster_whisper'")) reject(new Error(
          `В Python ${python} не установлен faster-whisper. ` +
          'Настройте окружение по разделу «Локальная транскрибация» в README.md'
        ))
        else reject(new Error(err.slice(0, 800) || `transcribe.py exited ${code}`))
      })
    })
    send(1, '')
    return { segments, language, duration: req.duration }
  } finally {
    current = null
    fs.unlink(wav).catch(() => { /* never created */ })
  }
}

export function registerTranscribeIpc(getWin: () => BrowserWindow | null) {
  ipcMain.handle('transcribe:run', (_e, req: TranscribeRequest) => {
    const win = getWin()
    if (!win) throw new Error('no window')
    return run(win, req)
  })
  ipcMain.handle('transcribe:cancel', () => {
    if (!current) return
    current.cancelled = true
    current.muxer?.cancel()
    current.py?.kill('SIGKILL')
  })

  // plain text IO for transcript files
  ipcMain.handle('file:read-text', async (_e, path: string) => {
    try {
      return await fs.readFile(path, 'utf8')
    } catch {
      return null
    }
  })
  ipcMain.handle('file:write-text', (_e, path: string, content: string) =>
    fs.writeFile(path, content, 'utf8')
  )
  ipcMain.handle('file:stat', async (_e, path: string) => {
    try {
      return (await fs.stat(path)).mtimeMs
    } catch {
      return null
    }
  })
}
