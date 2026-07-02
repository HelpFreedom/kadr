import type { Project, Clip, Track, MediaAsset } from '@shared/types'
import { Compositor, type LayerDraw } from '@/gl/compositor'
import { glowParams } from '@/gl/glow'
import { getCaptureFrame } from './fragmentCapture'
import { evalAnim } from './anim'
import { getTextLayer } from './text'
import { attachAudio, setElementGain, isRouted, resumeAudio } from './audio'

export interface ActiveLayer {
  clip: Clip
  track: Track
  asset?: MediaAsset
}

/** Source-media time for a clip-local timeline offset, honoring speed and looping. */
export function clipSourceTime(clip: Clip, asset: MediaAsset | undefined, rel: number): number {
  const speed = clip.speed || 1
  let srcRel = rel * speed
  if (asset && asset.kind !== 'image' && asset.duration > 0) {
    const span = Math.max(0.05, asset.duration - clip.inPoint)
    if (srcRel >= span) srcRel %= span // extended beyond the source — loop
  }
  return clip.inPoint + srcRel
}

/** Combined fade-in/out gain (0..1) at a clip-local time. */
export function fadeFactor(
  clip: Clip,
  rel: number,
  fades?: { fadeIn: number; fadeOut: number }
): number {
  let f = 1
  const fi = fades ? fades.fadeIn : clip.fadeIn ?? 0
  const fo = fades ? fades.fadeOut : clip.fadeOut ?? 0
  if (fi > 0.001 && rel < fi) f *= Math.max(0, rel / fi)
  const tail = clip.duration - rel
  if (fo > 0.001 && tail < fo) f *= Math.max(0, tail / fo)
  return f
}

/**
 * Auto-crossfade: when clips overlap on the same track, the overlap behaves
 * as a fade-out of the earlier clip into a fade-in of the later one (audio).
 */
export function overlapFades(track: Track, clip: Clip): { fadeIn: number; fadeOut: number } {
  let fadeIn = clip.fadeIn ?? 0
  let fadeOut = clip.fadeOut ?? 0
  const end = clip.start + clip.duration
  for (const o of track.clips) {
    if (o.id === clip.id) continue
    const oEnd = o.start + o.duration
    // an earlier clip covers our head — fade in over the overlap
    if (o.start <= clip.start + 1e-6 && oEnd > clip.start + 1e-6 && oEnd < end - 1e-6) {
      fadeIn = Math.max(fadeIn, oEnd - clip.start)
    }
    // a later clip covers our tail — fade out over the overlap
    if (o.start > clip.start + 1e-6 && o.start < end - 1e-6 && oEnd >= end - 1e-6) {
      fadeOut = Math.max(fadeOut, end - o.start)
    }
  }
  return { fadeIn, fadeOut }
}

/** Visible video layers at time t, in draw order (bottom first). */
export function videoLayersAt(project: Project, t: number): ActiveLayer[] {
  const layers: ActiveLayer[] = []
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]
    if (track.kind !== 'video' || track.muted) continue
    const active = track.clips
      .filter((c) => t >= c.start && t < c.start + c.duration)
      .sort((a, b) => a.start - b.start)
    for (const clip of active) {
      layers.push({
        clip,
        track,
        asset: clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined
      })
    }
  }
  return layers
}

/** Clips that should produce sound at time t (video and audio tracks). */
export function audibleClipsAt(project: Project, t: number): ActiveLayer[] {
  const out: ActiveLayer[] = []
  for (const track of project.tracks) {
    if (track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'media' || clip.muted) continue
      if (t < clip.start || t >= clip.start + clip.duration) continue
      const asset = project.assets.find((a) => a.id === clip.assetId)
      if (asset?.hasAudio) out.push({ clip, track, asset })
    }
  }
  return out
}

/** Media clips that start soon — pre-seeked so cuts don't flash black. */
export function upcomingClipsAt(project: Project, t: number, horizon: number): ActiveLayer[] {
  const out: ActiveLayer[] = []
  for (const track of project.tracks) {
    if (track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'media') continue
      if (clip.start <= t || clip.start > t + horizon) continue
      const asset = project.assets.find((a) => a.id === clip.assetId)
      if (asset && asset.kind !== 'image') out.push({ clip, track, asset })
    }
  }
  return out
}

export interface MediaPoolOptions {
  /** route elements through WebAudio (per-clip gain + meter) */
  audio?: boolean
  /** decode preview proxies instead of the originals when available */
  proxy?: boolean
}

export class MediaPool {
  private items = new Map<string, HTMLVideoElement | HTMLImageElement>()
  private srcs = new Map<string, string>()

  constructor(private opts: MediaPoolOptions = {}) {}

  get(clipId: string, asset: MediaAsset): HTMLVideoElement | HTMLImageElement {
    let el = this.items.get(clipId)
    const url = window.kadr.fileUrl(
      this.opts.proxy && asset.proxyPath ? asset.proxyPath : asset.path
    )
    if (!el) {
      if (asset.kind === 'image') {
        el = new Image()
        // without CORS the kadr:// image is tainted on modern Chromium and
        // texImage2D refuses it — the clip simply vanishes from the preview
        el.crossOrigin = 'anonymous'
      } else {
        el = document.createElement('video')
        el.preload = 'auto'
        el.crossOrigin = 'anonymous'
        if (this.opts.audio) attachAudio(el)
      }
      this.items.set(clipId, el)
    }
    if (this.srcs.get(clipId) !== url) {
      el.src = url
      this.srcs.set(clipId, url)
      if (el instanceof HTMLVideoElement) el.load()
    }
    return el
  }

  /** Set playback volume; in WebAudio mode values above 1 boost the signal. */
  setVolume(el: HTMLVideoElement, v: number) {
    if (this.opts.audio && isRouted(el)) {
      el.volume = 1
      setElementGain(el, v)
    } else {
      el.volume = Math.min(1, Math.max(0, v))
    }
  }

  /** Drop elements whose clips no longer exist. */
  prune(liveClipIds: Set<string>) {
    for (const [id, el] of this.items) {
      if (!liveClipIds.has(id)) {
        if (el instanceof HTMLVideoElement) {
          el.pause()
          el.removeAttribute('src')
          el.load()
        }
        this.items.delete(id)
        this.srcs.delete(id)
      }
    }
  }

  pauseAllExcept(activeIds: Set<string>) {
    for (const [id, el] of this.items) {
      if (!activeIds.has(id) && el instanceof HTMLVideoElement && !el.paused) el.pause()
    }
  }

  dispose() {
    this.prune(new Set())
  }
}

/**
 * Active edge ("tip") effect at a clip-local time, if any. The phase runs
 * 0 → 0.5 across an out tip (peak at the clip end) and 0.5 → 1 across an
 * in tip (peak at the clip start), matching the shader convention where the
 * cut sits at 0.5 — two tips at a butt joint read as one continuous move.
 */
export function edgeAt(clip: Clip, rel: number): { type: string; g: number } | null {
  const tin = clip.transitionIn
  if (tin && tin.duration > 0.001 && rel < tin.duration) {
    return { type: tin.type, g: 0.5 + 0.5 * Math.max(0, rel / tin.duration) }
  }
  const tout = clip.transitionOut
  if (tout && tout.duration > 0.001) {
    const from = clip.duration - tout.duration
    if (rel >= from) {
      return { type: tout.type, g: 0.5 * Math.min(1, (rel - from) / tout.duration) }
    }
  }
  return null
}

/** Frame blending: the successor frame drawn over the main one with weight w. */
export interface BlendFrame {
  frame: VideoFrame
  w: number
}

/**
 * Draw one frame of the project at time t into the given compositor.
 * `frames` (export fast path) overrides per-clip video sources with decoded
 * WebCodecs frames; clips without an entry fall back to pool elements.
 * `blends` adds frame blending: the successor source frame is composited
 * over the main one with its weight, smoothing fps-mismatch cadence.
 */
export function drawFrame(
  comp: Compositor,
  project: Project,
  t: number,
  pool: MediaPool,
  frames?: Map<string, VideoFrame>,
  blends?: Map<string, BlendFrame>
) {
  comp.setSize(project.width, project.height)
  comp.begin(project.background)
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const track = project.tracks[i]
    if (track.kind !== 'video' || track.muted) continue
    // video-track gain doubles as a whole-track opacity slider
    const trackOpacity = Math.min(1, Math.max(0, track.gain ?? 1))
    if (trackOpacity <= 0.001) continue
    const active = track.clips
      .filter((c) => t >= c.start && t < c.start + c.duration)
      .sort((a, b) => a.start - b.start)
    const assetOf = (c: Clip) =>
      c.assetId ? project.assets.find((a) => a.id === c.assetId) : undefined
    // clip tails/heads with edge effects render through an offscreen pass
    const drawWithEdge = (c: Clip) => {
      const eff = edgeAt(c, t - c.start)
      if (eff && eff.g > 0.003 && eff.g < 0.997) {
        comp.beginOverlay(0)
        drawClipLayer(comp, project, t, pool, c, track, assetOf(c), 1, frames, blends)
        comp.endOverlay()
        comp.drawEdgeEffect(eff.type, eff.g, trackOpacity)
      } else {
        drawClipLayer(comp, project, t, pool, c, track, assetOf(c), trackOpacity, frames, blends)
      }
    }

    // Vegas-style transition: the two topmost overlapping clips blend on GPU
    let pair: [Clip, Clip] | null = null
    let pairType = 'crossfade'
    if (active.length >= 2) {
      const A = active[active.length - 2]
      const B = active[active.length - 1]
      // a transitionIn with a duration is an edge tip, not an overlap blend
      const tin = B.transitionIn
      const type = tin && tin.duration <= 0.001 ? tin.type : 'crossfade'
      if (B.start < A.start + A.duration - 1e-6 && B.start > A.start && type !== 'none') {
        pair = [A, B]
        pairType = type
      }
    }
    if (pair) {
      for (const c of active) {
        if (c !== pair[0] && c !== pair[1]) drawWithEdge(c)
      }
      const [A, B] = pair
      const overlapEnd = Math.min(A.start + A.duration, B.start + B.duration)
      const p = Math.min(1, Math.max(0, (t - B.start) / Math.max(0.001, overlapEnd - B.start)))
      comp.beginOverlay(0)
      drawClipLayer(comp, project, t, pool, A, track, assetOf(A), 1, frames, blends)
      comp.beginOverlay(1)
      drawClipLayer(comp, project, t, pool, B, track, assetOf(B), 1, frames, blends)
      comp.endOverlay()
      comp.drawTransition(pairType, p, trackOpacity)
    } else {
      for (const c of active) drawWithEdge(c)
    }
  }
}

function drawClipLayer(
  comp: Compositor,
  project: Project,
  t: number,
  pool: MediaPool,
  clip: Clip,
  track: Track,
  asset: MediaAsset | undefined,
  trackOpacity: number,
  frames?: Map<string, VideoFrame>,
  blends?: Map<string, BlendFrame>
) {
  {
    const rel = t - clip.start
    const m = clip.mask
    const tr = clip.transform
    const shapes = clip.maskShapes ?? (clip.maskShape ? [clip.maskShape] : [])
    const cropV = (a: { value: number } | undefined) =>
      a ? Math.min(0.5, Math.max(0, evalAnim(a, rel))) : 0
    const motion = track.motion
    const common = {
      x: evalAnim(tr.x, rel),
      y: evalAnim(tr.y, rel),
      scale: evalAnim(tr.scale, rel),
      rotation: evalAnim(tr.rotation, rel),
      rotX: tr.rotX ? evalAnim(tr.rotX, rel) : 0,
      rotY: tr.rotY ? evalAnim(tr.rotY, rel) : 0,
      z: tr.z ? evalAnim(tr.z, rel) : 0,
      // whole-track motion keyframes live in absolute project time
      outer: motion
        ? {
            x: evalAnim(motion.x, t),
            y: evalAnim(motion.y, t),
            scale: evalAnim(motion.scale, t),
            rotation: evalAnim(motion.rotation, t),
            rotX: evalAnim(motion.rotX, t),
            rotY: evalAnim(motion.rotY, t),
            z: evalAnim(motion.z, t)
          }
        : undefined,
      opacity: evalAnim(tr.opacity, rel) * fadeFactor(clip, rel) * trackOpacity,
      crop: m
        ? ([cropV(m.left), cropV(m.top), cropV(m.right), cropV(m.bottom)] as [number, number, number, number])
        : undefined,
      shapes: shapes.length
        ? shapes.map((ms) => ({
            type: (ms.type === 'rect' ? 1 : ms.type === 'ellipse' ? 2 : 3) as 1 | 2 | 3,
            cx: evalAnim(ms.cx, rel),
            cy: evalAnim(ms.cy, rel),
            halfW: Math.max(0, evalAnim(ms.w, rel)) / 2,
            halfH: Math.max(0, evalAnim(ms.h, rel)) / 2,
            featherIn: Math.max(0, evalAnim(ms.featherIn, rel)),
            featherOut: Math.max(0, evalAnim(ms.featherOut, rel)),
            invert: ms.invert
          }))
        : undefined
    }
    if (common.opacity <= 0.001) return
    // enabled outer glows render the layer through the effect pass; smoke is
    // clocked by clip-local time, identical in preview and export
    const glows = (clip.effects ?? []).filter((e) => e.enabled && e.type === 'glow')
    // gaussian blur effect: size as a fraction of project height, so the
    // result is identical at any render resolution
    const blurFx = (clip.effects ?? []).find((e) => e.enabled && e.type === 'blur')
    const blurSize = typeof blurFx?.params.size === 'number' ? blurFx.params.size : 0
    const blurFrac = Math.max(0, blurSize) / Math.max(1, project.height)
    const emit = (...layers: LayerDraw[]) => {
      if (glows.length || blurFrac > 0.0002) {
        comp.drawLayerFx(layers, blurFrac, glows.map((g) => glowParams(g.params)), rel)
      } else {
        for (const l of layers) comp.drawLayer(l)
      }
    }
    if (clip.kind === 'remotion') {
      // captured fragments draw like any layer — masks/3D/transitions work;
      // uncaptured ones render through the iframe overlay instead
      const cf = clip.fragmentId ? getCaptureFrame(clip.fragmentId) : null
      if (cf) {
        emit({
          source: null,
          raw: cf,
          cacheKey: clip.id,
          dynamic: true,
          srcWidth: clip.fragmentMeta?.width ?? project.width,
          srcHeight: clip.fragmentMeta?.height ?? project.height,
          ...common
        })
      }
      return
    }
    if (clip.kind === 'text') {
      const layer = getTextLayer(
        clip.id, clip.text ?? '', clip.textStyle!, project.width, project.height
      )
      emit({
        source: layer.canvas,
        cacheKey: `${clip.id}:${layer.hash}`,
        dynamic: false,
        srcWidth: project.width,
        srcHeight: project.height,
        ...common
      })
    } else if (asset) {
      if (asset.kind === 'audio') return
      const vf = frames?.get(clip.id)
      if (vf) {
        const layers: LayerDraw[] = [{
          source: vf as unknown as TexImageSource,
          cacheKey: clip.id,
          dynamic: true,
          srcWidth: vf.displayWidth || asset.width,
          srcHeight: vf.displayHeight || asset.height,
          ...common
        }]
        const bl = blends?.get(clip.id)
        if (bl) {
          // successor frame over the main one: out = A·(1−w) + B·w
          layers.push({
            ...layers[0],
            source: bl.frame as unknown as TexImageSource,
            cacheKey: `${clip.id}:b`,
            srcWidth: bl.frame.displayWidth || asset.width,
            srcHeight: bl.frame.displayHeight || asset.height,
            opacity: common.opacity * bl.w
          })
        }
        emit(...layers)
        return
      }
      const el = pool.get(clip.id, asset)
      if (el instanceof HTMLVideoElement) {
        if (el.readyState < 2) return
        emit({
          source: el,
          cacheKey: clip.id,
          dynamic: true,
          srcWidth: el.videoWidth || asset.width,
          srcHeight: el.videoHeight || asset.height,
          ...common
        })
      } else {
        if (!el.complete || !el.naturalWidth) return
        emit({
          source: el,
          cacheKey: clip.id,
          dynamic: false,
          srcWidth: el.naturalWidth,
          srcHeight: el.naturalHeight,
          ...common
        })
      }
    }
  }
}

interface PlayerHooks {
  getState(): { project: Project; playhead: number; playing: boolean }
  setPlayhead(t: number): void
  setPlaying(p: boolean): void
  setLoading(l: boolean): void
  duration(): number
}

/** Live preview: master clock + media element sync + GPU composite. */
export class Player {
  private comp: Compositor | null = null
  private pool = new MediaPool({ audio: true, proxy: true })
  private raf = 0
  private gcCounter = 0
  private wasLoading = false
  private lastDrawnProject: Project | null = null
  private lastDrawnT = -1
  private stableTicks = 0
  /** playback clock anchor — see tick() */
  private anchor: { ts: number; t: number } | null = null
  private lastSet = -1

  constructor(private hooks: PlayerHooks) {}

  attach(canvas: HTMLCanvasElement) {
    this.comp = new Compositor(canvas)
    let lastErrLog = 0
    const loop = (ts: number) => {
      // one bad frame (corrupt clip data, GL hiccup) must never kill the
      // loop — an unre-scheduled rAF means no preview and no playback for
      // the rest of the session, which reads as "the editor broke"
      try {
        this.tick(ts)
      } catch (err) {
        if (ts - lastErrLog > 2000) {
          lastErrLog = ts
          console.error('player tick failed:', err)
        }
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  detach() {
    cancelAnimationFrame(this.raf)
    this.pool.dispose()
    this.comp = null
  }

  private tick(ts: number) {
    const { project, playhead, playing } = this.hooks.getState()

    let t = playhead
    if (playing) {
      resumeAudio()
      // anchored clock: rAF timestamps are vsync-aligned, so projecting from
      // a fixed anchor gives constant velocity — accumulating per-frame
      // deltas would fold frame-time jitter into the motion (visible judder)
      if (!this.anchor || Math.abs(playhead - this.lastSet) > 1e-9) {
        this.anchor = { ts, t: playhead } // started or externally scrubbed
      }
      const dur = this.hooks.duration()
      t = this.anchor.t + (ts - this.anchor.ts) / 1000
      if (t >= dur) {
        t = dur
        this.hooks.setPlaying(false)
      }
      this.hooks.setPlayhead(t)
      this.lastSet = t
    } else {
      this.anchor = null
    }

    this.syncMedia(project, t, playing)

    // paused with nothing changed: idle at ~4 fps instead of a full 60 fps
    // composite (texture re-uploads of every visible video are not free) —
    // late-arriving seeks still show up within a quarter second
    const dirty = playing || project !== this.lastDrawnProject || t !== this.lastDrawnT
    if (dirty) this.stableTicks = 0
    else this.stableTicks++
    const skipDraw = !dirty && this.stableTicks > 20 && this.stableTicks % 15 !== 0
    if (this.comp && !skipDraw) {
      drawFrame(this.comp, project, t, this.pool)
      this.lastDrawnProject = project
      this.lastDrawnT = t
    }

    if (++this.gcCounter % 120 === 0) {
      this.comp?.collect()
      const live = new Set<string>()
      for (const tr of project.tracks) for (const c of tr.clips) live.add(c.id)
      this.pool.prune(live)
    }
  }

  private syncMedia(project: Project, t: number, playing: boolean) {
    const activeIds = new Set<string>()
    const seen = new Set<string>()
    let loading = false

    const visual = videoLayersAt(project, t).filter(
      (l) => l.asset && l.asset.kind === 'video'
    )
    const audible = audibleClipsAt(project, t)

    for (const { clip, track, asset } of [...visual, ...audible]) {
      if (seen.has(clip.id)) continue
      seen.add(clip.id)
      const el = this.pool.get(clip.id, asset!)
      if (!(el instanceof HTMLVideoElement)) continue
      activeIds.add(clip.id)

      const rel = t - clip.start
      const desired = clipSourceTime(clip, asset, rel)
      const isAudible = audible.some((a) => a.clip.id === clip.id)
      el.muted = !isAudible || !playing
      this.pool.setVolume(el, Math.max(0,
        evalAnim(clip.gain, rel) * track.gain * fadeFactor(clip, rel, overlapFades(track, clip))
      ))
      el.playbackRate = clip.speed || 1

      if (el.readyState < 2) loading = true
      if (playing) {
        // Resync discipline: a seek on a software-decoded element takes
        // ~0.1-0.2 s, during which the master clock runs on — naively
        // reseeking on every drift made each correction land already
        // behind, storming into a seek-per-few-frames flicker at high
        // clip speeds. Never reseek mid-seek, scale the tolerance with
        // speed, and aim slightly AHEAD so the seek lands on time.
        const speed = clip.speed || 1
        const tolerance = Math.max(0.15, 0.08 * speed)
        if (!el.seeking && Math.abs(el.currentTime - desired) > tolerance) {
          el.currentTime = desired + 0.08 * speed
        }
        if (el.paused) el.play().catch(() => { /* not ready yet */ })
      } else {
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - desired) > 0.04 && el.readyState >= 1 && !el.seeking) {
          el.currentTime = desired
        }
        if (el.seeking) loading = true
      }
    }

    // preroll: seek clips that start within ~2s so cuts don't flash black
    for (const { clip, asset } of upcomingClipsAt(project, t, 2)) {
      if (seen.has(clip.id)) continue
      seen.add(clip.id)
      const el = this.pool.get(clip.id, asset!)
      if (!(el instanceof HTMLVideoElement)) continue
      activeIds.add(clip.id) // keep it from being paused-collected mid-seek
      el.muted = true
      if (!el.paused) el.pause()
      const desired = clipSourceTime(clip, asset, 0)
      if (Math.abs(el.currentTime - desired) > 0.2 && el.readyState >= 1 && !el.seeking) {
        el.currentTime = desired
      }
    }

    this.pool.pauseAllExcept(activeIds)
    if (loading !== this.wasLoading) {
      this.wasLoading = loading
      this.hooks.setLoading(loading)
    }
  }
}
