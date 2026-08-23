// Loudness envelope of a timeline range for the neon-wave module: mix the
// requested AudioSegments to a temp wav (the export segment graph — WYSIWYG
// sound), decode it to f32 stereo and run the Blender-compatible follower from
// shared/envelope.ts. Returns one value per fragment frame.
import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FFMPEG, mixdownWav, runStream } from './ffmpeg'
import { EnvelopeFollower } from '@shared/envelope'
import type { EnvelopeRequest } from '@shared/types'

const SR = 48000
const CHANNELS = 2

export async function computeEnvelope(req: EnvelopeRequest): Promise<number[]> {
  const fps = Number(req.fps)
  const duration = Number(req.duration)
  if (!(fps > 0) || !(duration > 0)) throw new Error('envelope: bad fps/duration')
  const frames = Math.max(1, Math.round(duration * fps))
  // Nothing audible in the range (silence, only text/remotion clips): a flat
  // zero curve. ExportMuxer with zero inputs would build an ffmpeg command
  // without any -i and fail, so never get there.
  if (!req.audioSegments?.length) return new Array(frames).fill(0)

  const wav = join(tmpdir(), `kadr-envelope-${Date.now()}-${process.pid}.wav`)
  try {
    await mixdownWav(req.audioSegments, duration, wav)
    const follower = new EnvelopeFollower(SR, CHANNELS, fps, frames, {
      attack: req.attack,
      release: req.release
    })
    // f32le chunks are not aligned to 4 bytes, let alone to stereo frames —
    // carry the remainder between chunks (the follower carries partial frames).
    let rest: Buffer = Buffer.alloc(0)
    await runStream(
      FFMPEG,
      ['-v', 'error', '-i', wav, '-f', 'f32le', '-ac', String(CHANNELS), '-ar', String(SR), '-'],
      (chunk) => {
        const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
        const usable = buf.length - (buf.length % 4)
        if (usable) {
          // copy into an aligned Float32Array (Buffer slices may be unaligned)
          const f32 = new Float32Array(usable / 4)
          new Uint8Array(f32.buffer).set(buf.subarray(0, usable))
          follower.push(f32)
        }
        rest = Buffer.from(buf.subarray(usable))
      }
    )
    return follower.result()
  } finally {
    fs.unlink(wav).catch(() => { /* never created */ })
  }
}

// one job at a time: two dialogs must not race ffmpeg on the CPU
let chain: Promise<unknown> = Promise.resolve()

export function registerEnvelopeIpc() {
  ipcMain.handle('audio:envelope', (_e, req: EnvelopeRequest) => {
    const job = chain.then(() => computeEnvelope(req))
    chain = job.catch(() => undefined)
    return job
  })
}
