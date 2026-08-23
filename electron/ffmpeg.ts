// ffmpeg/ffprobe helpers running in the main process.
import { execFile, spawn, ChildProcess } from 'child_process'
import { promisify } from 'util'
import { promises as fsp } from 'fs'
import { join, basename } from 'path'
import type { ProbeResult, ExportJob, ExportProgress, WaveformData } from '@shared/types'
import { rawEncodeArgs } from '@shared/rawEncode'

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
  const name = basename(path)

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
  if (kind === 'video' && video?.codec_name) asset.codec = video.codec_name
  if (kind === 'video') {
    // alpha travels two ways: an alpha pixel format (yuva…, rgba, prores
    // 4444) or WebM's container-level alpha_mode tag (vp8/vp9 alpha planes —
    // their pix_fmt still reads plain yuv420p)
    const pf = String(video?.pix_fmt ?? '')
    const tagAlpha = String(video?.tags?.alpha_mode ?? video?.tags?.ALPHA_MODE ?? '') === '1'
    const pfAlpha = /^(yuva|rgba|argb|abgr|bgra|gbrap|ya8|ya16)/.test(pf)
    if (tagAlpha || pfAlpha) asset.hasAlpha = true
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

/** Input decoder flags: vpx alpha only decodes through the libvpx decoders
    (the native vp8/vp9 decoder silently drops the alpha plane). */
function alphaInputArgs(codec?: string): string[] {
  if (codec === 'vp9') return ['-c:v', 'libvpx-vp9']
  if (codec === 'vp8') return ['-c:v', 'libvpx']
  return []
}

/**
 * Preview proxy: light 540p H.264 + AAC copy of a heavy source. Sources with
 * an alpha channel become VP9+alpha WebM instead — H.264 would bake the
 * transparency into a solid background. The preview decodes this instead of
 * the original; export always reads the original.
 */
export function makeProxy(
  src: string,
  out: string,
  duration: number,
  onProgress?: (p: number) => void,
  opts?: { alpha?: boolean; codec?: string }
): Promise<void> {
  const args = opts?.alpha ? [
    '-y', '-v', 'error', '-progress', 'pipe:1',
    ...alphaInputArgs(opts.codec),
    '-i', src,
    '-vf', "scale=-2:'min(540,ih)'",
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '32', '-b:v', '0',
    '-cpu-used', '8', '-row-mt', '1',
    '-c:a', 'libopus', '-b:a', '96k',
    out
  ] : [
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

/**
 * EBU R128 loudness of a source range: integrated LUFS + true peak dBTP
 * from ffmpeg's loudnorm measurement pass (JSON printed to stderr).
 */
export function measureLoudness(
  src: string,
  start: number,
  duration: number
): Promise<{ i: number; tp: number }> {
  const args = [
    '-v', 'info', '-nostats',
    ...(start > 0 ? ['-ss', start.toFixed(3)] : []),
    ...(duration > 0 ? ['-t', duration.toFixed(3)] : []),
    '-i', src, '-vn',
    '-af', 'loudnorm=I=-14:TP=-1:print_format=json',
    '-f', 'null', '-'
  ]
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, args, { maxBuffer: 8 * 1024 * 1024 }, (err, _out, stderr) => {
      // ffmpeg exits 0 on success; the measurement JSON is on stderr
      const m = String(stderr).match(/\{[^{}]*"input_i"[\s\S]*?\}/)
      if (!m) {
        reject(err instanceof Error ? err : new Error(`loudnorm produced no measurement: ${String(stderr).slice(-300)}`))
        return
      }
      try {
        const j = JSON.parse(m[0])
        const i = parseFloat(j.input_i)
        const tp = parseFloat(j.input_tp)
        if (!isFinite(i) || i <= -70) {
          reject(new Error('clip audio is silent — nothing to normalize'))
          return
        }
        resolve({ i, tp: isFinite(tp) ? tp : -1 })
      } catch (e) { reject(e as Error) }
    })
  })
}

export interface PackedAlphaPlan {
  /** false = keep the slower element-decode path for this source */
  canPack: boolean
  /** the matrix a browser decode of this source ends up using */
  matrix: string
  /** size the packed intermediate will reach, bytes per second of source */
  bytesPerSecond: number
}

/**
 * Everything requestDecoded needs to decide on packing a source as
 * colour-over-matte, from ONE ffprobe.
 *
 * Every source but a full-range one can be packed: the packer converts the
 * picture to BT.709 limited, the one space Chromium hands to WebGL untouched.
 * (Full-range YUV is rare in alpha footage and would need its own dance, so
 * it keeps the slower element-decode path — correct, just slow.)
 */
export async function packedAlphaPlan(src: string): Promise<PackedAlphaPlan> {
  const t = await probeColorTags(src)
  // The lossless intermediate grows with PIXELS, not with running time:
  // measured 3.7 MB/s for 1080p60, i.e. ~0.030 bytes per source pixel. The
  // disk check used to reserve a flat 9 MB/s, which happens to be that same
  // 2.4× margin at 1080p60 and a serious UNDER-estimate at anything larger —
  // 4K carries four times the pixels, so a long 4K source could pass the
  // check and then run the volume dry mid-build. Keep the margin, follow the
  // frame size. A source that would not probe is assumed to be 1080p60,
  // exactly what the flat figure assumed.
  const w = t.width || 1920
  const h = t.height || 1080
  const fps = t.fps || 60
  return {
    canPack: t.range !== 'pc',
    // Untagged footage (Remotion's VP9 renders included) is read as BT.601 by
    // the <video> pipeline — measured against known RGB: BT.709 turned pure
    // red into (255, 36, 12).
    matrix: t.matrix || 'bt601',
    bytesPerSecond: w * h * fps * 0.075
  }
}

async function probeColorTags(
  src: string
): Promise<{ matrix: string; range: string; width: number; height: number; fps: number }> {
  let s: Record<string, string> = {}
  try {
    const { stdout } = await execFileP(FFPROBE, [
      '-v', 'error', '-select_streams', 'v:0', '-print_format', 'json',
      '-show_entries', 'stream=width,height,r_frame_rate,color_space,color_range', src
    ], { maxBuffer: 1024 * 1024 })
    s = (JSON.parse(stdout).streams || [])[0] || {}
  } catch { /* fall through to the heuristic */ }
  const known = (v?: string) => (v && v !== 'unknown' && v !== 'reserved' ? v : '')
  const [num, den] = String(s.r_frame_rate || '').split('/')
  const fps = Number(num) / (Number(den) || 1)
  return {
    matrix: known(s.color_space),
    range: known(s.color_range) === 'pc' ? 'pc' : 'tv',
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 0
  }
}

/**
 * Full-resolution H.264 intermediate for sources Chromium cannot decode
 * (HEVC without VAAPI, mpeg4, prores, …). Near-lossless on purpose — the
 * export pipeline re-encodes it once more; video-only (the audio mix always
 * reads the original).
 */
export async function makeDecoded(
  src: string,
  out: string,
  duration: number,
  onProgress?: (p: number) => void,
  opts?: { alpha?: boolean; codec?: string; packed?: boolean; matrix?: string }
): Promise<void> {
  const args = opts?.packed ? [
    // ALPHA FAST PATH. Chromium's WebCodecs cannot decode alpha at all
    // (VP9-alpha WebM carries it as container side data; ProRes 4444 is
    // unsupported), so alpha sources fell back to per-frame <video> seeks —
    // ~0.2 s per frame, i.e. 4 fps exports. Packing colour over its alpha
    // matte into ONE ordinary H.264 MP4 (2× height) turns them into plain
    // mp4s the fast demux+WebCodecs path reads at full speed; the compositor
    // shader recombines the halves. LOSSLESS on purpose (-qp 0): the export
    // must be pixel-identical to the old element-decode path, so this
    // intermediate may not add a generation. The matte is mapped full→limited
    // range so the decoder's limited→full expansion restores it exactly.
    // Cost: ~400 MB per minute of 1080p60, encoded at ~1.3× realtime once
    // per source (cached); the disk guard in requestDecoded keeps it sane.
    '-y', '-v', 'error', '-progress', 'pipe:1',
    ...alphaInputArgs(opts.codec),
    '-i', src,
    '-filter_complex',
    '[0:v]format=yuva420p,split=2[c][a];' +
    // the picture's samples are copied verbatim — no colour conversion is
    // applied here or tagged on the file, so the decoder treats it exactly
    // like the original (guaranteed by the BT.709/HD gate in requestDecoded)
    // The picture is converted to BT.709 limited — a pure matrix change
    // (swscale, no gamma or gamut transform), a no-op when the source is
    // BT.709 already. It has to be BT.709: Chromium runs its own colour
    // transform on any other space while uploading the frame, and that
    // transform would also sweep over the bottom half and lift the alpha
    // matte (128 → 143). A matte is not colour and must arrive verbatim.
    `[c]format=yuv420p,scale=in_color_matrix=${opts.matrix || 'bt601'}:out_color_matrix=bt709[col];` +
    // the matte rides in the luma plane, mapped into the same limited range
    // the decoder will expand back — verified to round-trip bit-exactly
    '[a]alphaextract,format=yuv420p,scale=in_range=pc:out_range=tv[m];' +
    '[col][m]vstack=inputs=2[v]',
    '-map', '[v]', '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuv420p',
    // deliberately UNTAGGED: a tagged frame reaches WebGL through Chromium's
    // colour-managed upload, which rewrites mid-tones (it lifted the alpha
    // matte 128 → 143). Untagged frames are re-wrapped on the CPU by
    // Mp4FrameSource and upload verbatim — the picture is already BT.709.
    '-movflags', '+faststart',
    out
  ] : opts?.alpha ? [
    // alpha sources (ProRes 4444, HEVC-alpha…) must keep transparency:
    // near-lossless VP9+alpha WebM, decoded by the element-seek path
    '-y', '-v', 'error', '-progress', 'pipe:1',
    ...alphaInputArgs(opts.codec),
    '-i', src,
    '-map', '0:v:0', '-an',
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-crf', '12', '-b:v', '0',
    '-cpu-used', '4', '-row-mt', '1',
    out
  ] : [
    '-y', '-v', 'error', '-progress', 'pipe:1',
    '-i', src,
    '-map', '0:v:0', '-an',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', '-pix_fmt', 'yuv420p',
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
      else reject(new Error(`decode ffmpeg exited ${code}: ${err.slice(0, 500)}`))
    })
  })
}

/**
 * Reversed copy of a source range. ffmpeg's `reverse` filter buffers every
 * decoded frame in RAM, so video is reversed in bounded chunks (frame budget
 * scaled by resolution) that are then concatenated in reverse order; audio is
 * tiny and reversed in one pass. Audio-only sources produce a lossless wav.
 */
export async function makeReversed(
  src: string,
  start: number,
  dur: number,
  out: string,
  info: { kind: string; hasAudio: boolean; width: number; height: number; fps: number },
  tmpDir: string,
  onProgress?: (p: number) => void
): Promise<void> {
  const run = (args: string[]) =>
    execFileP(FFMPEG, ['-y', '-v', 'error', ...args], { maxBuffer: 4 * 1024 * 1024 })
  const range = ['-ss', start.toFixed(3), '-t', dur.toFixed(3), '-i', src]

  if (info.kind !== 'video') {
    await run([...range, '-vn', '-af', 'areverse', '-c:a', 'pcm_s16le', out])
    onProgress?.(1)
    return
  }

  await fsp.mkdir(tmpDir, { recursive: true })
  try {
    // ~500 MB of raw frames per chunk, at least half a second
    const fps = info.fps || 30
    const frameBytes = Math.max(1, info.width * info.height * 1.5)
    const chunkSec = Math.max(0.5, Math.min(6, Math.floor(500e6 / frameBytes) / fps))
    const n = Math.max(1, Math.ceil(dur / chunkSec - 1e-6))
    const chunks: string[] = []
    for (let i = 0; i < n; i++) {
      const cs = start + i * chunkSec
      const cd = Math.min(chunkSec, start + dur - cs)
      const file = join(tmpDir, `c${i}.mp4`)
      await run([
        '-ss', cs.toFixed(3), '-t', cd.toFixed(3), '-i', src,
        '-vf', 'reverse', '-an',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-pix_fmt', 'yuv420p',
        file
      ])
      chunks.push(file)
      onProgress?.(((i + 1) / n) * 0.92) // the concat+audio tail is quick
    }
    const list = join(tmpDir, 'list.txt')
    await fsp.writeFile(list, chunks.reverse().map((f) => `file '${f}'`).join('\n'))
    if (info.hasAudio) {
      const ra = join(tmpDir, 'a.m4a')
      await run([...range, '-vn', '-af', 'areverse', '-c:a', 'aac', '-b:a', '192k', ra])
      await run([
        '-f', 'concat', '-safe', '0', '-i', list, '-i', ra,
        '-c', 'copy', '-movflags', '+faststart', out
      ])
    } else {
      await run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out])
    }
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* best effort */ })
  }
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

/**
 * Direct ffmpeg video encode: the renderer streams raw RGBA frames (WebGL
 * readPixels, bottom-up — hence vflip) over stdin and libx264/libvpx does the
 * real rate control. Chromium's WebCodecs encoders ignore the requested
 * bitrate (OpenH264 saturates at ~0.7 Mbit/s on real 1080p footage — soft,
 * "мыльный" output); x264 at the preset bitrate matches desktop NLEs.
 */
export class RawVideoEncoder {
  private child: ChildProcess | null = null
  private closed: Promise<void> | null = null
  private err = ''

  start(opts: {
    width: number
    height: number
    outWidth?: number
    outHeight?: number
    fps: number
    codec: string // 'libx264' or an ffmpegVideo codec like 'libvpx-vp9'
    bitrate: number
    out: string
  }) {
    const child = spawn(FFMPEG, rawEncodeArgs(opts), { stdio: ['pipe', 'ignore', 'pipe'] })
    this.child = child
    child.stderr!.on('data', (c) => { this.err += c })
    this.closed = new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => {
        this.child = null
        if (code === 0) resolve()
        else reject(new Error(`raw encoder exited ${code}: ${this.err.slice(0, 800)}`))
      })
    })
    this.closed.catch(() => { /* surfaced via write/finish */ })
  }

  write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin
      if (!stdin || stdin.destroyed) {
        reject(new Error(`raw encoder gone: ${this.err.slice(0, 300)}`))
        return
      }
      if (stdin.write(data)) resolve()
      else stdin.once('drain', resolve)
    })
  }

  async finish(): Promise<void> {
    this.child?.stdin?.end()
    await this.closed
  }

  kill() {
    try { this.child?.kill('SIGKILL') } catch { /* gone */ }
  }
}

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
