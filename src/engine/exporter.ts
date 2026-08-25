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
  MediaPool, drawFrame, frameSignature, videoLayersAt, clipSourceTime, overlapFades,
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
    // clip end times for the passed-clip cleanup below (the project is
    // frozen during an export, so this map never goes stale)
    const clipEnds = new Map<string, number>()
    for (const tr of project.tracks) {
      for (const c of tr.clips) clipEnds.set(c.id, c.start + c.duration)
    }
    // 180° shutter: sub-samples cover half the frame interval around t
    const blurSamples = opts?.motionBlur ? 8 : 1
    // fast path: sequential WebCodecs decode per clip; null = element seeks
    const sources = new Map<string, Mp4FrameSource | null>()
    const frames = new Map<string, VideoFrame>()
    // clips whose decoded frames carry colour over an alpha matte (2× tall)
    const packedClips = new Set<string>()
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
    // TWO is the measured optimum, not a placeholder. A buffer may only be
    // refilled once its write has actually reached the pipe (see
    // preload.rawEncodeFrame), so the ring depth is how far the loop may run
    // ahead of ffmpeg, and the loop does spend ~4 ms per frame waiting on it.
    // Deepening the ring does NOT recover that: the pipe is drained by libuv
    // on this very thread, so extra buffers add no concurrency, only working
    // set. Measured on a 1080p60 project, three alternating rounds each:
    //   2 slots → 50.5 fps (read 14.3, encode 4.2)
    //   3 slots → 45.7 fps (read 14.4, encode 6.2)
    //   4 slots → 45.3 fps (read 12.8, encode 8.1)
    // Pixels were identical at every depth; only the pacing changed.
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

    // stage timing accumulators — one summary line at export end shows where
    // the milliseconds go (decode / draw / readback / encode backpressure)
    const stat = { prepare: 0, draw: 0, read: 0, encode: 0, gc: 0 }
    let mark = 0
    const lap = (key: keyof typeof stat) => {
      const now = performance.now()
      stat[key] += now - mark
      mark = now
    }
    try {
      const totalFrames = Math.max(1, Math.round(duration * fps))
      for (let k = 0; k < totalFrames; k++) {
        if (cancelled) throw new Error('cancelled')
        if (encodeError) throw encodeError
        // a lost context makes every GL call a no-op — readPixels then leaves
        // its buffer untouched and the run would finish "successfully" as a
        // black file. Fail loudly instead.
        if (comp.contextLost()) throw new Error(`GPU context lost at frame ${k} — restart Kadr and export again`)
        // sample mid-frame to avoid cut-boundary ambiguity
        const t = span.start + (k + 0.5) / fps
        mark = performance.now()
        await prepareFrame(project, t, pool, fps, sources, frames, blends, packedClips)
        lap('prepare')
        if (blurSamples > 1) {
          const sub = (s: number) => t + ((s + 0.5) / blurSamples - 0.5) * (0.5 / fps)
          // A 180° shutter only shows up when something MOVES within it. If
          // the composition is identical at every sub-sample time (no
          // keyframes, fades, transitions or glow clocks running — most of a
          // finished edit), the 8 sub-composites are pixel-identical and
          // their mean is the single composite: draw it once. Exact, not an
          // approximation — and the accumulator path is kept so the result
          // goes through the very same blit as before.
          const noCollapse = (globalThis as { KADR_FORCE_FULL_SHUTTER?: boolean }).KADR_FORCE_FULL_SHUTTER
          let same = noCollapse ? null : frameSignature(project, t, pool, frames, blends, packedClips)
          for (let s = 0; s < blurSamples && same !== null; s++) {
            if (frameSignature(project, sub(s), pool, frames, blends, packedClips) !== same) same = null
          }
          comp.setRenderTarget(true)
          if (same !== null) {
            drawFrame(comp, project, t, pool, frames, blends, packedClips)
            comp.accumBlit(1)
          } else {
            comp.holdSources(true) // the decoded frames don't change per sub-sample
            for (let s = 0; s < blurSamples; s++) {
              // transforms/masks/track motion move between sub-samples;
              // the decoded video frames stay those of the frame center
              drawFrame(comp, project, sub(s), pool, frames, blends, packedClips)
              comp.accumBlit(1 / (s + 1))
            }
            comp.holdSources(false)
          }
          comp.setRenderTarget(false)
        } else {
          drawFrame(comp, project, t, pool, frames, blends, packedClips)
        }
        lap('draw')
        if (useRaw) {
          if (rawDirect) {
            // pipelined readback: queue frame k into its PBO (no GPU sync),
            // then retrieve frame k−1 — the GPU had a whole frame to finish
            // it, so getBufferSubData barely blocks. Frames still reach
            // ffmpeg strictly in order, one frame later.
            comp.startRead(k & 1)
            if (k > 0) {
              const s = (k - 1) & 1
              if (slotPending[s]) await slotPending[s] // ffmpeg still owns this one
              lap('encode')
              comp.finishRead(s, slots[s])
              // Debug hook: `globalThis.KADR_FRAME_HASH = []` before an
              // export collects a hash per rendered frame, so a change can be
              // proven to leave the picture bit-identical (see e2e32).
              const hashes = (globalThis as { KADR_FRAME_HASH?: number[] }).KADR_FRAME_HASH
              if (hashes) {
                const b = slots[s]
                let h = 2166136261
                for (let i = 0; i < b.length; i += 997) h = Math.imul(h ^ b[i], 16777619)
                hashes.push(h >>> 0)
              }
              lap('read')
              slotPending[s] = window.kadr.rawEncodeFrame(slots[s])
            }
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
        mark = performance.now()
        if (k % 30 === 29) {
          // release decoders and media elements of clips the export has fully
          // passed: every source held its decoded frames until the very end,
          // so memory grew with total clip COUNT — a 391-clip project reached
          // ~7 GB and the kernel OOM killer took the renderer down at 99%.
          // The 1 s margin covers motion-blur sub-samples and overlap
          // transitions; a deleted entry would simply re-open on demand.
          const horizon = t - 1
          let released = false
          for (const [clipId, src] of sources) {
            const end = clipEnds.get(clipId)
            if (end !== undefined && end < horizon) {
              src?.close()
              sources.delete(clipId)
              packedClips.delete(clipId) // a re-open decides its own layout
              released = true
            }
          }
          if (released) {
            const keep = new Set<string>()
            for (const [clipId, end] of clipEnds) {
              if (end >= horizon) keep.add(clipId)
            }
            pool.prune(keep)
          }
          comp.collect() // drop GPU textures idle for 300+ frames
          lap('gc')
        }
      }
      console.info('[kadr] export stage ms/frame:', JSON.stringify(Object.fromEntries(
        Object.entries(stat).map(([k2, v]) => [k2, Math.round((v / totalFrames) * 100) / 100])
      )))
      if (useRaw) {
        if (rawDirect) {
          // flush the last frame still sitting in its PBO
          const s = (totalFrames - 1) & 1
          if (slotPending[s]) await slotPending[s]
          comp.finishRead(s, slots[s])
          slotPending[s] = window.kadr.rawEncodeFrame(slots[s])
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
      // the per-frame guard above cannot see a loss during the LAST frame
      if (comp.contextLost()) throw new Error('GPU context lost while rendering the final frame — restart Kadr and export again')
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
      // the export canvas is detached and never reused, so its context can go
      // now instead of waiting for GC (see Compositor.dispose)
      try { comp.dispose() } catch { /* context already gone */ }
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
    blends?: Map<string, BlendFrame>,
    packed?: Set<string>
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
        const noPack = (globalThis as { KADR_DISABLE_ALPHA_PACK?: boolean }).KADR_DISABLE_ALPHA_PACK
        if (!src && !fastOff && !noPack && asset.hasAlpha) {
          // Alpha video (VP9-alpha WebM — every transparent Remotion
          // fragment — ProRes 4444, HEVC-alpha) has no WebCodecs decode
          // path: the element fallback seeks per frame at ~0.2 s each, so
          // exports crawled at ~4 fps. A cached lossless H.264 mp4 holding
          // the colour over its alpha matte decodes at full speed and the
          // shader splits it back apart, pixel for pixel.
          const alt = await alphaPackedFallback(asset)
          if (alt) {
            src = await Mp4FrameSource.open(alt, { alphaPacked: true })
            if (src) packed?.add(clip.id)
          }
        }
        if (!src && !fastOff) {
          // Chromium can't decode some codecs at all (HEVC without VAAPI,
          // ProRes, mpeg4, …): WebCodecs rejects them and a <video> element
          // renders 0×0 — the element path would export black. Re-encode
          // once to a cached full-res intermediate (H.264, or VP9+alpha
          // WebM for alpha sources) and decode that instead: mp4 through
          // the fast path, webm through the element via a pool override.
          const alt = await undecodableFallback(asset)
          if (alt) {
            src = await Mp4FrameSource.open(alt)
            if (!src) pool.setSourceOverride(clip.id, alt.path)
          }
        }
        sources.set(clip.id, src)
        console.info(`[kadr] export decode for ${asset.name}: ` +
          `${src ? (packed?.has(clip.id) ? 'webcodecs (packed alpha)' : 'webcodecs') : 'element'}`)
      }
      if (src) {
        const s = src
        // blend only when the source can't fill every project frame (25 fps
        // footage in a 60 fps project, slow motion); matched or faster
        // sources stay untouched — no blanket softening
        // Frame blending composites the successor frame OVER the main one,
        // which only reproduces lerp(A, B, w) while the layer is opaque: with
        // per-pixel alpha the two passes stack (0.5 → 0.56 effective alpha,
        // measured), so alpha sources stay unblended — exactly as they were
        // before they had a fast decode path at all.
        const srcRate = asset.hasAlpha
          ? 1
          : ((clip.speed || 1) * (asset.fps || fps)) / fps
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
              packed?.delete(clip.id) // element frames are plain RGBA
              s.close()
              return seekElement(clip.id, asset, srcT)
            },
            () => {
              // fast path died (codec quirk?) — element seeks from here on
              console.warn(`[kadr] fast decode failed for ${asset.name} — falling back`)
              sources.set(clip.id, null)
              packed?.delete(clip.id) // element frames are plain RGBA
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
/**
 * Alpha sources decode through a cached, LOSSLESS H.264 mp4 that stacks the
 * colour frame over its alpha matte (2× height, matte carried as luma in
 * limited range so the decoder restores it bit-exactly). WebCodecs cannot
 * decode an alpha channel in any container, and the element-seek fallback
 * costs ~0.2 s per frame; this keeps the fast path AND the exact pixels.
 * null = packing failed (no ffmpeg, no disk space) — the caller then keeps
 * the slow element path, which is correct, just slow.
 */
const alphaPacks = new Map<string, Promise<MediaAsset | null>>()

function alphaPackedFallback(asset: MediaAsset): Promise<MediaAsset | null> {
  let p = alphaPacks.get(asset.path)
  if (!p) {
    p = (async () => {
      console.info(`[kadr] ${asset.name}: alpha source — building a packed (colour+matte) intermediate for fast decode`)
      const path = await window.kadr.requestDecoded(asset.path, asset.duration,
        { packed: true, alpha: true, codec: asset.codec })
      return { ...asset, path }
    })().catch((err) => {
      console.warn(`[kadr] alpha packing failed for ${asset.name} — keeping element seeks`, err)
      return null
    })
    alphaPacks.set(asset.path, p)
  }
  return p.then((alt) => (alt ? { ...asset, path: alt.path } : null))
}

const undecodable = new Map<string, Promise<MediaAsset | null>>()

function undecodableFallback(asset: MediaAsset): Promise<MediaAsset | null> {
  let p = undecodable.get(asset.path)
  if (!p) {
    p = (async () => {
      let { codec, hasAlpha } = asset
      if (!codec) {
        const fresh = (await window.kadr.probeMedia(asset.path)).asset
        codec = fresh.codec
        hasAlpha = fresh.hasAlpha
      }
      if (chromiumCanDecode(codec)) return null
      console.info(`[kadr] ${asset.name}: '${codec}' is not decodable by Chromium — building a ${hasAlpha ? 'VP9+alpha' : 'H.264'} intermediate`)
      const path = await window.kadr.requestDecoded(asset.path, asset.duration,
        { alpha: !!hasAlpha, codec })
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
  // Transparent fragments render to VP9+alpha WebM, which only the slow
  // element path can decode — build their packed intermediates here so the
  // cost shows up in the fragments phase instead of stalling the frame loop.
  const alphaAssets = [...new Set(rendered.values())]
    .map((id) => p.assets.find((a) => a.id === id))
    .filter((a): a is MediaAsset => !!a?.hasAlpha)
  if (alphaAssets.length) {
    let n = 0
    const offP = window.kadr.onProxyProgress(({ progress }) => {
      onProgress({ phase: 'fragments', progress: (n + progress) / alphaAssets.length })
    })
    try {
      for (const a of alphaAssets) {
        await alphaPackedFallback(a)
        n++
      }
    } finally {
      offP()
    }
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
