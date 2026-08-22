// Transcription backend: mix the requested audio to a temp wav (the same
// segment graph as exports — what you hear is what gets transcribed), then
// run faster-whisper via scripts/transcribe.py, streaming progress and live
// text to the renderer. One job at a time.
import { app, ipcMain, BrowserWindow, dialog } from 'electron'
import { execFile, spawn, ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { basename, extname, join } from 'path'
import { homedir, tmpdir } from 'os'
import { createHash } from 'crypto'
import { promisify } from 'util'
import { ExportMuxer } from './ffmpeg'
import type { TranscribeRequest, TranscribeResult, TranscribeSegment } from '@shared/types'

const execFileAsync = promisify(execFile)

let current: {
  ownerId: number
  muxer: ExportMuxer | null
  py: ChildProcess | null
  cancelled: boolean
} | null = null

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
  const job = {
    ownerId: win.webContents.id,
    muxer: null as ExportMuxer | null,
    py: null as ChildProcess | null,
    cancelled: false
  }
  current = job
  const wav = join(tmpdir(), `kadr-transcribe-${job.ownerId}-${Date.now()}.wav`)
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

export function registerTranscribeIpc() {
  ipcMain.handle('transcribe:run', (event, req: TranscribeRequest) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('no window')
    return run(win, req)
  })
  ipcMain.handle('transcribe:cancel', (event) => {
    if (!current || current.ownerId !== event.sender.id) return
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

  ipcMain.handle('text:create-srt', async (event, suggestedName: string, start: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new Error('no window')
    const safeName = (suggestedName || 'subtitles')
      .replace(/\.srt$/i, '')
      .replace(/[^\p{L}\p{N} _.-]+/gu, '_')
      .trim()
      .slice(0, 80) || 'subtitles'
    const result = await dialog.showSaveDialog(win, {
      title: 'Создать файл субтитров',
      defaultPath: join(app.getPath('documents'), `${safeName}.srt`),
      filters: [{ name: 'SubRip subtitles', extensions: ['srt'] }]
    })
    if (result.canceled || !result.filePath) return null
    const path = result.filePath.toLowerCase().endsWith('.srt')
      ? result.filePath
      : `${result.filePath}.srt`
    const from = Math.max(0, Number.isFinite(start) ? start : 0)
    const toSrtTime = (seconds: number) => {
      const ms = Math.round(seconds * 1000)
      const hh = Math.floor(ms / 3_600_000)
      const mm = Math.floor((ms % 3_600_000) / 60_000)
      const ss = Math.floor((ms % 60_000) / 1000)
      const mmm = ms % 1000
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:` +
        `${String(ss).padStart(2, '0')},${String(mmm).padStart(3, '0')}`
    }
    await fs.writeFile(path, `1\n${toSrtTime(from)} --> ${toSrtTime(from + 3)}\n\n`, 'utf8')
    return path
  })

  ipcMain.handle('text:prepare-document', async (_event, path: string) => {
    const ext = extname(path).toLowerCase()
    if (ext !== '.doc' && ext !== '.docx') throw new Error('Поддерживаются только DOC и DOCX')
    if (process.platform !== 'darwin') {
      throw new Error('Импорт DOC/DOCX сейчас поддерживается только в версии Kadr для macOS')
    }
    const stat = await fs.stat(path)
    if (!stat.isFile()) throw new Error('Файл сценария не найден')
    if (stat.size > 100 * 1024 * 1024) throw new Error('Файл сценария больше 100 МБ')
    const converted = await execFileAsync('/usr/bin/textutil', [
      '-convert', 'txt', '-stdout', path
    ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })
    const text = String(converted.stdout).replace(/^\uFEFF/, '')
    if (!text.trim()) throw new Error(`В ${basename(path)} не найден текст`)
    const dir = join(app.getPath('userData'), 'text-documents')
    await fs.mkdir(dir, { recursive: true })
    const tag = createHash('sha1')
      .update(`${path}\0${stat.size}\0${stat.mtimeMs}`)
      .digest('hex')
      .slice(0, 12)
    const stem = basename(path, ext).replace(/[^\p{L}\p{N}_.-]+/gu, '_').slice(0, 70) || 'document'
    const outputPath = join(dir, `${stem}-${tag}.txt`)
    const pending = `${outputPath}.part`
    await fs.writeFile(pending, text, 'utf8')
    await fs.rename(pending, outputPath)
    return { path: outputPath, name: basename(path) }
  })
}
