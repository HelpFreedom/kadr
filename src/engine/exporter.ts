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

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const comp = new Compositor(canvas)
    comp.setSize(width, height)
    const pool = new MediaPool()
    // 180° shutter: sub-samples cover half the frame interval around t
    const blurSamples = opts?.motionBlur ? 8 : 1
    // fast path: sequential WebCodecs decode per clip; null = element seeks
    const sources = new Map<string, Mp4FrameSource | null>()
    const frames = new Map<string, VideoFrame>()
    const blends = opts?.frameBlending === false ? undefined : new Map<string, BlendFrame>()

    let writeChain: Promise<void> = Promise.resolve()
    const muxer = new Muxer({
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

    let encodeError: Error | null = null
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
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
    console.info(`[kadr] export encoder: ${hw?.supported ? 'hardware' : 'software'}`)
    encoder.configure(config)

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
        const frame = new VideoFrame(canvas, {
          timestamp: Math.round((k * 1e6) / fps),
          duration: Math.round(1e6 / fps)
        })
        encoder.encode(frame, { keyFrame: k % (Math.round(fps) * 2) === 0 })
        frame.close()
        while (encoder.encodeQueueSize > 8) await sleep(4)
        if (k % 5 === 0 || k === totalFrames - 1) {
          onProgress({ phase: 'video', progress: (k + 1) / totalFrames })
        }
      }
      await encoder.flush()
      muxer.finalize()
      await writeChain
      // hand off to ffmpeg in the main process (audio mix + mux);
      // further progress arrives via onExportProgress events
      await window.kadr.exportVideoDone()
    } catch (err) {
      await window.kadr.exportCancel().catch(() => { /* already gone */ })
      throw err
    } finally {
      try { encoder.close() } catch { /* already closed */ }
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
        src = (globalThis as { KADR_DISABLE_FAST_DECODE?: boolean }).KADR_DISABLE_FAST_DECODE
          ? null
          : await Mp4FrameSource.open(asset)
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
