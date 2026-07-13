// Offline export: frame-accurate WYSIWYG render of the project through the
// same compositor as the preview, hardware-encoded via WebCodecs, muxed to a
// temp MP4 by mp4-muxer; the main process then mixes audio with ffmpeg and
// muxes/transcodes into the final file.
import { Muxer, StreamTarget } from 'mp4-muxer'
import type {
  ExportPreset, ExportProgress, Project, AudioSegment, MediaAsset
} from '@shared/types'
import { uid } from '@/state/store'
import { Compositor } from '@/gl/compositor'
import {
  MediaPool, drawFrame, videoLayersAt, clipSourceTime, overlapFades,
  type BlendFrame
} from './player'
import { Mp4FrameSource } from './demux'
import { chromiumCanDecode } from './codecs'
import { evalAnim } from './anim'
import { activity } from './autosave'
import { projectDuration } from '@/state/store'

export interface ExportHandle {
  cancel(): void
  done: Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface TimeRange {
  start: number
  end: number
}

/**
 * Audio segments intersected with the export range and shifted to its start.
 * Clips extended beyond their source loop, which yields several sub-segments;
 * speed is handed to ffmpeg as an atempo chain, fades as afade windows.
 */
function collectAudioSegments(project: Project, range: TimeRange): AudioSegment[] {
  const segs: AudioSegment[] = []
  for (const track of project.tracks) {
    if (track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'media' || clip.muted) continue
      const asset = project.assets.find((a) => a.id === clip.assetId)
      if (!asset?.hasAudio) continue
      const speed = clip.speed || 1
      const span = Math.max(0.05, asset.duration - clip.inPoint) // source seconds available
      const from = Math.max(clip.start, range.start)
      const to = Math.min(clip.start + clip.duration, range.end)
      if (to - from < 0.001) continue
      const gain = evalAnim(clip.gain, 0) * track.gain
      // overlapping neighbours on the track auto-crossfade
      const { fadeIn, fadeOut } = overlapFades(track, clip)

      let local = from - clip.start // clip-local timeline position
      const localEnd = to - clip.start
      while (local < localEnd - 0.001) {
        const srcOff = (local * speed) % span
        const untilWrap = (span - srcOff) / speed // timeline seconds until the loop wraps
        const segDur = Math.min(untilWrap, localEnd - local)
        // clip-global fades clipped to this sub-segment's local window
        const fiLocal = local < fadeIn ? Math.min(fadeIn - local, segDur) : 0
        const tail = clip.duration - (local + segDur)
        const foLocal = tail < fadeOut ? Math.min(fadeOut - tail, segDur) : 0
        segs.push({
          path: asset.path,
          inPoint: clip.inPoint + srcOff,
          duration: segDur * speed,
          start: clip.start + local - range.start,
          gain,
          speed,
          fadeIn: fiLocal,
          fadeOut: foLocal
        })
        local += segDur
      }
    }
  }
  return segs
}

function avcCodecString(width: number, height: number, fps: number): string {
  const mbPerSec = Math.ceil(width / 16) * Math.ceil(height / 16) * fps
  // levels: 4.0 covers 1080p30, 5.1 covers 4K30, 5.2 covers 4K60
  const level = mbPerSec > 983040 ? 0x34 : mbPerSec > 245760 ? 0x33 : 0x28
  return `avc1.6400${level.toString(16).padStart(2, '0')}`
}

export interface ExportOptions {
  /** AE-style shutter blur: average sub-frame composites per output frame */
  motionBlur?: boolean
  /** mix neighbouring source frames when the source fps can't fill the
      project fps (25→60, slow motion) — smooths content cadence */
  frameBlending?: boolean
  /** 'x264' (default) streams raw frames to ffmpeg — real rate control,
      desktop-NLE quality; 'webcodecs' keeps the old in-browser encoder
      (faster, but Chromium's OpenH264 ignores the preset bitrate) */
  encoder?: 'x264' | 'webcodecs'
}

export function startExport(
  project: Project,
  preset: ExportPreset,
  outputPath: string,
  onProgress: (p: ExportProgress) => void,
  range?: TimeRange | null,
  opts?: ExportOptions
): ExportHandle {
  let cancelled = false
  const done = run()
  return { cancel: () => { cancelled = true }, done }

  async function run(): Promise<void> {
    activity.exporting = true
    try {
      await runInner()
    } finally {
      activity.exporting = false
    }
  }

  async function runInner(): Promise<void> {
    // remotion fragments render exactly once (content-hash cached) and turn
    // into ordinary media clips for the rest of the pipeline
    project = await materializeFragments(project, onProgress)
    const width = preset.width === 'project' ? project.width : preset.width
    const height = preset.height === 'project' ? project.height : preset.height
    const fps = preset.fps === 'project' ? project.fps : preset.fps
    const span: TimeRange = range ?? { start: 0, end: projectDuration(project) }
    const duration = span.end - span.start
    if (duration <= 0) throw new Error('empty project')

    await window.kadr.exportBegin({
      projectName: project.name,
      preset,
      outputPath,
      width,
      height,
      fps,
      duration,
      audioSegments: collectAudioSegments(project, span)
    })

    if (preset.audioOnly) {
      await window.kadr.exportVideoDone()
      return
    }

    // drawFrame composites in PROJECT space (layer transforms, masks and
    // effects are all in project pixels — it forces comp.setSize to project
    // dims on every call). Frames are therefore rendered at project size and
    // scaled to the preset size at the encoder: ffmpeg -vf scale (raw path)
    // or a 2D fit blit (webcodecs path). Reading preset-sized buffers out of
    // a project-sized framebuffer was GL_INVALID_OPERATION → black exports.
    const rw = project.width
    const rh = project.height
    const canvas = document.createElement('canvas')
    canvas.width = rw
    canvas.height = rh
    const comp = new Compositor(canvas)
    comp.setSize(rw, rh)
    const pool = new MediaPool()
    // 180° shutter: sub-samples cover half the frame interval around t
    const blurSamples = opts?.motionBlur ? 8 : 1
    // fast path: sequential WebCodecs decode per clip; null = element seeks
    const sources = new Map<string, Mp4FrameSource | null>()
    const frames = new Map<string, VideoFrame>()
    const blends = opts?.frameBlending === false ? undefined : new Map<string, BlendFrame>()

    // default: stream raw frames to ffmpeg/libx264 in main — Chromium's
    // WebCodecs encoders ignore the preset bitrate and produce soft output.
    // The IPC transfer is pipelined: invoke() serializes the buffer
    // synchronously, so the loop keeps decoding/drawing the next frames
    // while up to RAW_AHEAD transfers are still in flight (ffmpeg encodes
    // in its own process in parallel anyway).
    const useRaw = opts?.encoder !== 'webcodecs'
    const rawBuf = useRaw ? new Uint8Array(rw * rh * 4) : null
    const RAW_AHEAD = 3
    const rawInFlight: Promise<void>[] = []
    // frames travel over a local binary WebSocket when main offers one:
    // ws.send() costs a plain memcpy, while an 8 MB IPC invoke burns ~20 ms
    // of renderer main-thread on Electron's structured-clone serialization
    let rawWs: WebSocket | null = null

    let writeChain: Promise<void> = Promise.resolve()
    let muxer: Muxer<StreamTarget> | null = null
    let encoder: VideoEncoder | null = null
    let encodeError: Error | null = null
    // best transport: preload spawns ffmpeg inside this process; with
    // contextIsolation off the frame buffers pass by reference (no copies).
    // Double buffer: fill one while ffmpeg still owns the other. Falls back
    // to main-side WS, then IPC.
    let rawDirect: string | null = null
    const slots: Uint8Array[] = []
    const slotPending: (Promise<void> | null)[] = [null, null]
    if (useRaw) {
      const codec = preset.ffmpegVideo === 'copy' ? 'libx264' : preset.ffmpegVideo
      try {
        rawDirect = await window.kadr.rawEncodeStart({
          width: rw, height: rh, outWidth: width, outHeight: height,
          fps, codec, bitrate: preset.videoBitrate
        })
        for (let s = 0; s < 2; s++) slots.push(new Uint8Array(rw * rh * 4))
      } catch (err) {
        console.warn('[kadr] direct raw encoder unavailable, falling back', err)
        rawDirect = null
      }
      if (!rawDirect) {
        const wsPort = await window.kadr.exportRawBegin(rw, rh, fps, width, height)
        if (wsPort > 0) {
          rawWs = await new Promise<WebSocket | null>((res) => {
            const s = new WebSocket(`ws://127.0.0.1:${wsPort}`)
            s.binaryType = 'arraybuffer'
            s.onopen = () => res(s)
            s.onerror = () => res(null) // IPC fallback
          })
        }
      }
      console.info(`[kadr] export encoder: ffmpeg x264 (${rawDirect ? 'direct' : rawWs ? 'ws' : 'ipc'} pipe)`)
    } else {
      muxer = new Muxer({
        target: new StreamTarget({
          onData: (data, position) => {
            const copy = data.slice().buffer
            writeChain = writeChain.then(() => window.kadr.exportVideoChunk(copy, position))
          },
          chunked: true
        }),
        video: { codec: 'avc', width, height },
        fastStart: false,
        firstTimestampBehavior: 'offset'
      })
      encoder = new VideoEncoder({
        output: (chunk, meta) => muxer!.addVideoChunk(chunk, meta),
        error: (e) => { encodeError = e }
      })
      const baseConfig: VideoEncoderConfig = {
        codec: avcCodecString(width, height, fps),
        width,
        height,
        bitrate: preset.videoBitrate,
        framerate: fps,
        latencyMode: 'quality'
      }
      // prefer the GPU encoder (VAAPI) and fall back to software when missing
      let config: VideoEncoderConfig = { ...baseConfig, hardwareAcceleration: 'prefer-hardware' }
      const hw = await VideoEncoder.isConfigSupported(config).catch(() => null)
      if (!hw?.supported) config = { ...baseConfig, hardwareAcceleration: 'no-preference' }
      console.info(`[kadr] export encoder: webcodecs ${hw?.supported ? 'hardware' : 'software'}`)
      encoder.configure(config)
    }

    // webcodecs path renders into the muxed stream directly ('copy' presets
    // never re-encode), so its frames must already be preset-sized: blit the
    // project-sized canvas into a centered fit rectangle when sizes differ
    let fit: { c: HTMLCanvasElement; g: CanvasRenderingContext2D
               dx: number; dy: number; dw: number; dh: number } | null = null
    if (!useRaw && (width !== rw || height !== rh)) {
      const c = document.createElement('canvas')
      c.width = width
      c.height = height
      const s = Math.min(width / rw, height / rh)
      const dw = Math.round(rw * s)
      const dh = Math.round(rh * s)
      fit = { c, g: c.getContext('2d')!,
              dx: Math.floor((width - dw) / 2), dy: Math.floor((height - dh) / 2), dw, dh }
    }

    try {
      const totalFrames = Math.max(1, Math.round(duration * fps))
      for (let k = 0; k < totalFrames; k++) {
        if (cancelled) throw new Error('cancelled')
        if (encodeError) throw encodeError
        // sample mid-frame to avoid cut-boundary ambiguity
        const t = span.start + (k + 0.5) / fps
        await prepareFrame(project, t, pool, fps, sources, frames, blends)
        if (blurSamples > 1) {
          comp.setRenderTarget(true)
          for (let s = 0; s < blurSamples; s++) {
            // transforms/masks/track motion move between sub-samples;
            // the decoded video frames stay those of the frame center
            const ts = t + ((s + 0.5) / blurSamples - 0.5) * (0.5 / fps)
            drawFrame(comp, project, ts, pool, frames, blends)
            comp.accumBlit(1 / (s + 1))
          }
          comp.setRenderTarget(false)
        } else {
          drawFrame(comp, project, t, pool, frames, blends)
        }
        if (useRaw) {
          if (rawDirect) {
            const s = k & 1
            if (slotPending[s]) await slotPending[s] // ffmpeg still owns this one
            comp.readPixels(slots[s])
            slotPending[s] = window.kadr.rawEncodeFrame(slots[s])
          } else if (rawWs) {
            comp.readPixels(rawBuf!)
            rawWs.send(rawBuf!) // copies synchronously — the buffer is reusable
            while (rawWs.bufferedAmount > 64_000_000) await sleep(2)
            if (rawWs.readyState !== WebSocket.OPEN) throw new Error('raw frame socket died')
          } else {
            comp.readPixels(rawBuf!)
            rawInFlight.push(window.kadr.exportRawFrame(rawBuf!.buffer))
            if (rawInFlight.length >= RAW_AHEAD) await rawInFlight.shift()
          }
        } else {
          if (fit) {
            fit.g.fillStyle = '#000'
            fit.g.fillRect(0, 0, width, height)
            fit.g.drawImage(canvas, fit.dx, fit.dy, fit.dw, fit.dh)
          }
          const frame = new VideoFrame(fit ? fit.c : canvas, {
            timestamp: Math.round((k * 1e6) / fps),
            duration: Math.round(1e6 / fps)
          })
          encoder!.encode(frame, { keyFrame: k % (Math.round(fps) * 2) === 0 })
          frame.close()
          while (encoder!.encodeQueueSize > 8) await sleep(4)
        }
        if (k % 5 === 0 || k === totalFrames - 1) {
          onProgress({ phase: 'video', progress: (k + 1) / totalFrames })
        }
      }
      if (useRaw) {
        if (rawDirect) {
          for (const p of slotPending) if (p) await p
          await window.kadr.rawEncodeEnd()
          await window.kadr.exportUseVideo(rawDirect)
        } else {
          if (rawWs) {
            // TCP delivers in order: once our close handshake completes, main
            // has every frame — only then may raw-end flush the encoder
            while (rawWs.bufferedAmount > 0) await sleep(5)
            await new Promise<void>((res) => {
              rawWs!.onclose = () => res()
              rawWs!.close()
            })
          }
          await Promise.all(rawInFlight)
          await window.kadr.exportRawEnd()
        }
      } else {
        await encoder!.flush()
        muxer!.finalize()
        await writeChain
      }
      // hand off to ffmpeg in the main process (audio mix + mux);
      // further progress arrives via onExportProgress events
      await window.kadr.exportVideoDone()
    } catch (err) {
      if (rawDirect) window.kadr.rawEncodeKill()
      await window.kadr.exportCancel().catch(() => { /* already gone */ })
      throw err
    } finally {
      try { rawWs?.close() } catch { /* already closed */ }
      try { encoder?.close() } catch { /* already closed */ }
      for (const src of sources.values()) src?.close()
      pool.dispose()
    }
  }

  /**
   * Make every visible video layer's frame available for time t: WebCodecs
   * sequential decode where the container/codec allows it (each frame decoded
   * exactly once, with read-ahead), element seeks for everything else — and
   * as a per-clip fallback if the fast path fails mid-export.
   */
  async function prepareFrame(
    project: Project,
    t: number,
    pool: MediaPool,
    fps: number,
    sources: Map<string, Mp4FrameSource | null>,
    frames: Map<string, VideoFrame>,
    blends?: Map<string, BlendFrame>
  ): Promise<void> {
    frames.clear()
    blends?.clear()
    const waits: Promise<void>[] = []
    const seen = new Set<string>()
    const seekElement = (clipId: string, asset: MediaAsset, srcT: number) => {
      const el = pool.get(clipId, asset)
      if (!(el instanceof HTMLVideoElement)) return Promise.resolve()
      el.muted = true
      el.pause()
      return seekVideo(el, srcT, 0.45 / fps)
    }
    for (const { clip, asset } of videoLayersAt(project, t)) {
      if (!asset || seen.has(clip.id)) continue
      seen.add(clip.id)
      if (asset.kind === 'image') {
        const el = pool.get(clip.id, asset) as HTMLImageElement
        if (!el.complete) waits.push(el.decode().catch(() => { /* skip broken */ }))
        continue
      }
      if (asset.kind !== 'video') continue
      const srcT = clipSourceTime(clip, asset, t - clip.start)
      let src = sources.get(clip.id)
      if (src === undefined) {
        const fastOff = (globalThis as { KADR_DISABLE_FAST_DECODE?: boolean }).KADR_DISABLE_FAST_DECODE
        src = fastOff ? null : await Mp4FrameSource.open(asset)
        if (!src && !fastOff) {
          // Chromium can't decode some codecs at all (HEVC without VAAPI,
          // mpeg4, …): WebCodecs rejects them and a <video> element renders
          // 0×0 — the element path would export black. Re-encode once to a
          // cached full-res H.264 intermediate and fast-decode that instead.
          const alt = await undecodableFallback(asset)
          if (alt) src = await Mp4FrameSource.open(alt)
        }
        sources.set(clip.id, src)
        console.info(`[kadr] export decode for ${asset.name}: ${src ? 'webcodecs' : 'element'}`)
      }
      if (src) {
        const s = src
        // blend only when the source can't fill every project frame (25 fps
        // footage in a 60 fps project, slow motion); matched or faster
        // sources stay untouched — no blanket softening
        const srcRate = ((clip.speed || 1) * (asset.fps || fps)) / fps
        waits.push(
          s.frameAt(srcT).then(
            (f) => {
              if (f) {
                frames.set(clip.id, f)
                const nx = blends && srcRate < 0.999 ? s.next() : null
                if (nx) {
                  const t0 = f.timestamp
                  const t1 = nx.timestamp
                  const us = srcT * 1e6
                  if (t1 > t0 + 1000) {
                    const w = Math.min(1, Math.max(0, (us - t0) / (t1 - t0)))
                    if (w > 0.02) blends!.set(clip.id, { frame: nx, w })
                  }
                }
                return
              }
              // no frame is never acceptable — fall back so the output can
              // only ever be slower, not frozen
              console.warn(`[kadr] fast decode yielded no frame for ${asset.name} — falling back`)
              sources.set(clip.id, null)
              s.close()
              return seekElement(clip.id, asset, srcT)
            },
            () => {
              // fast path died (codec quirk?) — element seeks from here on
              console.warn(`[kadr] fast decode failed for ${asset.name} — falling back`)
              sources.set(clip.id, null)
              s.close()
              return seekElement(clip.id, asset, srcT)
            }
          )
        )
      } else {
        waits.push(seekElement(clip.id, asset, srcT))
      }
    }
    await Promise.all(waits)
  }
}

/**
 * A shim asset pointing at the cached ffmpeg H.264 intermediate when the
 * source codec is one Chromium cannot decode; null when the codec is fine
 * (the regular element fallback stays in charge) or the transcode failed.
 * Old projects saved before the codec field existed are re-probed once.
 */
const undecodable = new Map<string, Promise<MediaAsset | null>>()

function undecodableFallback(asset: MediaAsset): Promise<MediaAsset | null> {
  let p = undecodable.get(asset.path)
  if (!p) {
    p = (async () => {
      let codec = asset.codec
      if (!codec) codec = (await window.kadr.probeMedia(asset.path)).asset.codec
      if (chromiumCanDecode(codec)) return null
      console.info(`[kadr] ${asset.name}: '${codec}' is not decodable by Chromium — building an H.264 intermediate`)
      const path = await window.kadr.requestDecoded(asset.path, asset.duration)
      return { ...asset, path }
    })().catch((err) => {
      console.warn(`[kadr] decode fallback failed for ${asset.name}`, err)
      return null
    })
    undecodable.set(asset.path, p)
  }
  // shims carry per-asset metadata (name, fps…) — rebind onto this asset
  return p.then((alt) => (alt ? { ...asset, path: alt.path } : null))
}

/**
 * Replace every remotion clip with a media clip over a freshly rendered
 * (or cache-hit) fragment file — full resolution and fps, alpha kept for
 * transparent fragments. WYSIWYG: this clone is what gets exported.
 */
async function materializeFragments(
  project: Project,
  onProgress: (p: ExportProgress) => void
): Promise<Project> {
  const hasFrags = project.tracks.some((t) => t.clips.some((c) => c.kind === 'remotion'))
  if (!hasFrags) return project
  const p = JSON.parse(JSON.stringify(project)) as Project
  const rendered = new Map<string, string>() // fragmentId → assetId
  const todo = p.tracks.flatMap((t) => t.clips).filter((c) => c.kind === 'remotion' && c.fragmentId)
  let done = 0
  const off = window.kadr.onFragmentProgress(({ progress }) => {
    onProgress({ phase: 'fragments', progress: (done + progress) / todo.length })
  })
  try {
    for (const clip of todo) {
      let assetId = rendered.get(clip.fragmentId!)
      if (!assetId) {
        onProgress({ phase: 'fragments', progress: done / todo.length })
        const { path } = await window.kadr.fragmentRender(clip.fragmentId!, {
          transparent: clip.fragmentMeta?.transparent
        })
        const { asset } = await window.kadr.probeMedia(path)
        assetId = uid()
        p.assets.push({ id: assetId, ...asset })
        rendered.set(clip.fragmentId!, assetId)
      }
      clip.kind = 'media'
      clip.assetId = assetId
      done++
    }
  } finally {
    off()
  }
  return p
}

function seekVideo(el: HTMLVideoElement, time: number, tolerance = 0.005): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      el.removeEventListener('seeked', finish)
      el.removeEventListener('error', finish)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, 3000)
    const ready = () => {
      // skipping a sub-half-frame seek lets sequential frames decode forward
      if (Math.abs(el.currentTime - time) < tolerance && el.readyState >= 2 && !el.seeking) {
        finish()
        return
      }
      el.addEventListener('seeked', finish)
      el.addEventListener('error', finish)
      el.currentTime = time
    }
    if (el.readyState >= 1) ready()
    else {
      const meta = () => {
        el.removeEventListener('loadedmetadata', meta)
        ready()
      }
      el.addEventListener('loadedmetadata', meta)
    }
  })
}
