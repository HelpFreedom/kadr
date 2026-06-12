// ffmpeg/ffprobe helpers running in the main process.
import { execFile, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'
import type { ProbeResult, ExportJob, ExportProgress, WaveformData } from '@shared/types'

const execFileP = promisify(execFile)

export const FFMPEG = process.env.KADR_FFMPEG || 'ffmpeg'
export const FFPROBE = process.env.KADR_FFPROBE || 'ffprobe'

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|gif|tiff?)$/i

export async function probeMedia(path: string): Promise<ProbeResult> {
  const { stdout } = await execFileP(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    path
  ], { maxBuffer: 16 * 1024 * 1024 })
  const info = JSON.parse(stdout)
  const streams: any[] = info.streams || []
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find((s) => s.codec_type === 'audio')
  const isImage = !!video && (IMAGE_EXT.test(path) || (video.nb_frames === '1' && !audio))

  const duration = parseFloat(info.format?.duration ?? video?.duration ?? audio?.duration ?? '0') || 0
  let fps = 0
  if (video?.avg_frame_rate && video.avg_frame_rate !== '0/0') {
    const [n, d] = video.avg_frame_rate.split('/').map(Number)
    if (d > 0) fps = n / d
  }

  const kind = isImage ? 'image' : video ? 'video' : 'audio'
  const name = path.split('/').pop() || path

  const asset: ProbeResult['asset'] = {
    path,
    name,
    kind,
    duration: isImage ? 0 : duration,
    width: video?.width || 0,
    height: video?.height || 0,
    fps: fps || 30,
    hasAudio: !!audio
  }

  if (kind !== 'audio') {
    try {
      asset.thumbnail = await makeThumbnail(path, kind === 'image' ? 0 : Math.min(0.5, duration / 2))
    } catch { /* poster is optional */ }
    if (kind === 'video' && duration > 0.5) {
      try {
        asset.thumbnailEnd = await makeThumbnail(path, Math.max(0, duration - 0.3))
      } catch { /* tail poster is optional */ }
    }
  }
  if (audio && !isImage) {
    try {
      asset.waveform = await readWaveform(path, duration)
    } catch { /* waveform is optional */ }
  }
  return { asset }
}

async function makeThumbnail(path: string, at: number): Promise<string> {
  const args = [
    '-v', 'error',
    ...(at > 0 ? ['-ss', String(at)] : []),
    '-i', path,
    '-frames:v', '1',
    '-vf', 'scale=192:-2',
    '-f', 'image2pipe', '-vcodec', 'mjpeg', '-'
  ]
  const buf = await runCollect(FFMPEG, args)
  return 'data:image/jpeg;base64,' + buf.toString('base64')
}

/**
 * Audacity-style envelope: per-bin peak + RMS at up to 1000 bins/sec
 * (lower for very long files to cap the payload at ~2M bins).
 */
async function readWaveform(path: string, duration: number): Promise<WaveformData> {
  const SR = 16000
  const rate = Math.max(50, Math.min(1000, Math.floor(2_000_000 / Math.max(1, duration))))
  const bin = Math.max(1, Math.round(SR / rate))
  const raw = await runCollect(FFMPEG, [
    '-v', 'error', '-i', path,
    '-map', 'a:0', '-ac', '1', '-ar', String(SR),
    '-f', 's16le', '-'
  ], 2 * SR * Math.max(1, duration + 5) + 1024)
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2))
  const bins = Math.ceil(samples.length / bin)
  const maxArr = new Uint8Array(bins)
  const rmsArr = new Uint8Array(bins)
  for (let b = 0; b < bins; b++) {
    const from = b * bin
    const to = Math.min(from + bin, samples.length)
    let peak = 0
    let sq = 0
    for (let j = from; j < to; j++) {
      const v = Math.abs(samples[j])
      if (v > peak) peak = v
      sq += samples[j] * samples[j]
    }
    maxArr[b] = Math.min(255, Math.round((peak / 32768) * 255))
    rmsArr[b] = Math.min(255, Math.round((Math.sqrt(sq / Math.max(1, to - from)) / 32768) * 255))
  }
  return {
    rate: SR / bin,
    max: Buffer.from(maxArr).toString('base64'),
    rms: Buffer.from(rmsArr).toString('base64')
  }
}

/**
 * Preview proxy: light 540p H.264 + AAC copy of a heavy source. The preview
 * decodes this instead of the original; export always reads the original.
 */
export function makeProxy(
  src: string,
  out: string,
  duration: number,
  onProgress?: (p: number) => void
): Promise<void> {
  const args = [
    '-y', '-v', 'error', '-progress', 'pipe:1',
    '-i', src,
    '-vf', "scale=-2:'min(540,ih)'",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart',
    out
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    let buf = ''
    child.stdout.on('data', (c) => {
      buf += c
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const m = line.match(/^out_time_us=(\d+)/)
        if (m && duration > 0 && onProgress) {
          onProgress(Math.min(1, Number(m[1]) / 1e6 / duration))
        }
      }
    })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`proxy ffmpeg exited ${code}: ${err.slice(0, 500)}`))
    })
  })
}

/** atempo only accepts 0.5..2 per instance — chain factors for wider speeds. */
function atempoChain(speed: number): string[] {
  const out: string[] = []
  let s = Math.min(8, Math.max(0.25, speed))
  while (s > 2) {
    out.push('atempo=2')
    s /= 2
  }
  while (s < 0.5) {
    out.push('atempo=0.5')
    s /= 0.5
  }
  if (Math.abs(s - 1) > 1e-4) out.push(`atempo=${s.toFixed(5)}`)
  return out
}

function runCollect(bin: string, args: string[], maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let size = 0
    let err = ''
    child.stdout.on('data', (c: Buffer) => {
      size += c.length
      if (size > maxBytes) {
        child.kill('SIGKILL')
        reject(new Error('output too large'))
        return
      }
      chunks.push(c)
    })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new Error(`${bin} exited ${code}: ${err.slice(0, 500)}`))
    })
  })
}

// ---------------------------------------------------------------------------
// Final export pass: mix audio segments and mux with the rendered video.

export class ExportMuxer {
  private child: ChildProcess | null = null
  private cancelled = false

  cancel() {
    this.cancelled = true
    this.child?.kill('SIGKILL')
  }

  /**
   * @param videoTemp path to the renderer-produced video-only mp4 ('' for audio-only)
   */
  run(job: ExportJob, videoTemp: string, onProgress: (p: ExportProgress) => void): Promise<void> {
    const args: string[] = ['-y', '-v', 'error', '-progress', 'pipe:1']
    const segs = job.audioSegments
    const hasVideo = !job.preset.audioOnly

    if (hasVideo) args.push('-i', videoTemp)
    for (const s of segs) {
      args.push('-ss', String(s.inPoint), '-t', String(s.duration), '-i', s.path)
    }

    const filters: string[] = []
    if (segs.length > 0) {
      const labels: string[] = []
      segs.forEach((s, i) => {
        const idx = i + (hasVideo ? 1 : 0)
        const ms = Math.round(s.start * 1000)
        const speed = s.speed || 1
        const outDur = s.duration / speed // timeline-domain length after atempo
        const chain = [
          'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo',
          `volume=${s.gain.toFixed(4)}`,
          ...(Math.abs(speed - 1) > 1e-4 ? atempoChain(speed) : []),
          ...(s.fadeIn > 0.001 ? [`afade=t=in:st=0:d=${Math.min(s.fadeIn, outDur).toFixed(3)}`] : []),
          ...(s.fadeOut > 0.001
            ? [`afade=t=out:st=${Math.max(0, outDur - s.fadeOut).toFixed(3)}:d=${Math.min(s.fadeOut, outDur).toFixed(3)}`]
            : []),
          `adelay=${ms}|${ms}`,
          'apad',
          `atrim=0:${job.duration.toFixed(3)}`
        ]
        filters.push(`[${idx}:a]${chain.join(',')}[a${i}]`)
        labels.push(`[a${i}]`)
      })
      if (segs.length === 1) {
        filters.push(`${labels[0]}anull[aout]`)
      } else {
        // every padded stream is active for the whole duration, so amix scales
        // each by 1/N; volume=N restores the original levels
        filters.push(
          `${labels.join('')}amix=inputs=${segs.length}:dropout_transition=0,volume=${segs.length}[aout]`
        )
      }
      args.push('-filter_complex', filters.join(';'))
    }

    if (hasVideo) {
      args.push('-map', '0:v')
      if (job.preset.ffmpegVideo === 'copy') {
        args.push('-c:v', 'copy')
      } else {
        args.push('-c:v', job.preset.ffmpegVideo, '-b:v', String(job.preset.videoBitrate))
        if (job.preset.ffmpegVideo === 'libvpx-vp9') args.push('-row-mt', '1', '-cpu-used', '4')
      }
    }
    if (segs.length > 0) {
      args.push('-map', '[aout]', '-c:a', job.preset.audioCodec, '-b:a', job.preset.audioBitrate)
    } else if (hasVideo) {
      args.push('-an')
    }
    args.push('-t', String(job.duration), job.outputPath)

    return new Promise((resolve, reject) => {
      const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      let err = ''
      let buf = ''
      child.stdout!.on('data', (c) => {
        buf += c
        const lines = buf.split('\n')
        buf = lines.pop() || ''
        for (const line of lines) {
          const m = line.match(/^out_time_us=(\d+)/)
          if (m) {
            const t = Number(m[1]) / 1e6
            onProgress({ phase: 'mux', progress: Math.min(1, t / job.duration) })
          }
        }
      })
      child.stderr!.on('data', (c) => { err += c })
      child.on('error', reject)
      child.on('close', (code) => {
        this.child = null
        if (this.cancelled) reject(new Error('cancelled'))
        else if (code === 0) resolve()
        else reject(new Error(`ffmpeg exited ${code}: ${err.slice(0, 800)}`))
      })
    })
  }
}
