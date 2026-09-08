import type { Project, Clip, Track, MediaAsset } from '@shared/types'
import { Compositor, type LayerDraw } from '@/gl/compositor'
import { glowParams } from '@/gl/glow'
import { getCaptureFrame } from './fragmentCapture'
import { chromiumCanDecode } from './codecs'
import { evalAnim } from './anim'
import { getTextLayer } from './text'
import { attachAudio, setElementGain, isRouted, resumeAudio } from './audio'
import { logError } from './log'

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
  /** frame snapshots flip this on to decode ORIGINALS at full quality;
      codecs Chromium can't decode keep their proxy (original would be black) */
  sourceQuality = false
  /** per-clip source substitution: the exporter routes undecodable-codec
      clips through an ffmpeg intermediate that the element CAN play */
  private overrides = new Map<string, string>()

  constructor(private opts: MediaPoolOptions = {}) {}

  setSourceOverride(clipId: string, path: string | null) {
    if (path) this.overrides.set(clipId, path)
    else this.overrides.delete(clipId)
  }

  get(clipId: string, asset: MediaAsset): HTMLVideoElement | HTMLImageElement {
    let el = this.items.get(clipId)
    const override = this.overrides.get(clipId)
    const useProxy = !override && this.opts.proxy && !!asset.proxyPath &&
      (!this.sourceQuality || !chromiumCanDecode(asset.codec))
    const url = window.kadr.fileUrl(override ?? (useProxy ? asset.proxyPath! : asset.path))
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
 * Everything drawFrame would draw at time t, as a string — without touching
 * the GPU. Motion blur renders 8 sub-composites per output frame; whenever
 * the signature is the same at every sub-sample time (no keyframes moving,
 * no fade or transition in progress, no glow clock running — the common case
 * in a finished edit) the sub-composites are pixel-identical and one draw
 * gives EXACTLY the same output frame. Any difference at all, and the full
 * 8-sample pass runs as before, so this can only ever save redundant work.
 * A recorder that hits an unknown compositor call returns null = "assume it
 * moves".
 *
 * WHY THIS IS EXACT, AND THE ONE WAY TO BREAK IT. The signature is not a
 * hand-kept list of "things that count as movement" — it replays the real
 * drawFrame and records every compositor call with all of its arguments, so
 * new animated properties, effects and transitions are covered the day they
 * are added. The single input it does NOT record is the layer's `source`
 * object: only its cacheKey (and, for captured fragments, raw.version). That
 * is sound today because within one output frame no source can change — the
 * decoded VideoFrames are collected once per frame in the exporter's
 * prepareFrame, and pool elements are seeked there too, so every sub-sample
 * reads the very same pixels. It follows that motion blur smears TRANSFORMS,
 * never motion inside the footage. If sub-frame video sampling is ever added
 * (a true shutter, resampling the source at each sub-sample time), this
 * function must start recording what the source is showing — otherwise it
 * will silently declare those frames identical and freeze the very motion the
 * feature was written to blur.
 */
export function frameSignature(
  project: Project,
  t: number,
  pool: MediaPool,
  frames?: Map<string, VideoFrame>,
  blends?: Map<string, BlendFrame>,
  packed?: Set<string>
): string | null {
  const parts: string[] = []
  const sig = (l: LayerDraw) => {
    const { source, raw, ...rest } = l
    void source
    return JSON.stringify(rest) + (raw ? `#${raw.version}` : '')
  }
  const rec = {
    setSize: () => { /* size is constant within a frame */ },
    begin: (bg?: string) => parts.push(`B${bg}`),
    beginOverlay: (i: number) => parts.push(`O${i}`),
    endOverlay: () => parts.push('E'),
    drawEdgeEffect: (type: string, g: number, op: number) => parts.push(`G${type}|${g}|${op}`),
    drawTransition: (type: string, p: number, op: number) => parts.push(`T${type}|${p}|${op}`),
    drawLayer: (l: LayerDraw) => parts.push(`L${sig(l)}`),
    drawLayerFx: (layers: LayerDraw[], blur: number, glows: unknown[], rel: number) =>
      parts.push(`F${blur}|${JSON.stringify(glows)}|${rel}|${layers.map(sig).join('~')}`)
  }
  try {
    drawFrame(rec as unknown as Compositor, project, t, pool, frames, blends, packed)
  } catch {
    return null // an unrecorded compositor call — never collapse on a guess
  }
  return parts.join(';')
}

/**
 * Draw one frame of the project at time t into the given compositor.
 * `frames` (export fast path) overrides per-clip video sources with decoded
 * WebCodecs frames; clips without an entry fall back to pool elements.
 * `blends` adds frame blending: the successor source frame is composited
 * over the main one with its weight, smoothing fps-mismatch cadence.
 */
// Throttled so one persistently-broken clip can't flood the console every frame
// (preview redraws ~continuously; export runs thousands of frames).
let lastLayerErrLog = 0
function logLayerError(clip: Clip, err: unknown) {
  const now = Date.now()
  if (now - lastLayerErrLog > 2000) {
    lastLayerErrLog = now
    console.error(`[kadr] clip ${clip.id} failed to draw (skipped this frame):`, err)
  }
}

export function drawFrame(
  comp: Compositor,
  project: Project,
  t: number,
  pool: MediaPool,
  frames?: Map<string, VideoFrame>,
  blends?: Map<string, BlendFrame>,
  /** clips whose decoded frames are colour-over-alpha-matte (export only) */
  packed?: Set<string>
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
    // clip tails/heads with edge effects render through an offscreen pass.
    // Guarded per clip: a bad clip (e.g. a keyframe with no easing) must skip
    // only itself, not throw out of the layer loop and black out the whole frame
    // — comp.begin() already cleared the framebuffer above.
    const drawWithEdge = (c: Clip) => {
      try {
        const eff = edgeAt(c, t - c.start)
        if (eff && eff.g > 0.003 && eff.g < 0.997) {
          comp.beginOverlay(0)
          drawClipLayer(comp, project, t, pool, c, track, assetOf(c), 1, frames, blends, packed)
          comp.endOverlay()
          comp.drawEdgeEffect(eff.type, eff.g, trackOpacity)
        } else {
          drawClipLayer(comp, project, t, pool, c, track, assetOf(c), trackOpacity, frames, blends, packed)
        }
      } catch (err) {
        logLayerError(c, err)
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
      try {
        const overlapEnd = Math.min(A.start + A.duration, B.start + B.duration)
        const p = Math.min(1, Math.max(0, (t - B.start) / Math.max(0.001, overlapEnd - B.start)))
        comp.beginOverlay(0)
        drawClipLayer(comp, project, t, pool, A, track, assetOf(A), 1, frames, blends, packed)
        comp.beginOverlay(1)
        drawClipLayer(comp, project, t, pool, B, track, assetOf(B), 1, frames, blends, packed)
        comp.endOverlay()
        comp.drawTransition(pairType, p, trackOpacity)
      } catch (err) {
        // a throw mid-transition would leave the frame black; draw the pair
        // flat (each clip guarded) instead of losing the whole frame
        logLayerError(B, err)
        drawWithEdge(A)
        drawWithEdge(B)
      }
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
  blends?: Map<string, BlendFrame>,
  packed?: Set<string>
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
            type: (ms.type === 'rect' ? 1 : ms.type === 'ellipse' ? 2 : ms.type === 'roundrect' ? 4 : 3) as 1 | 2 | 3 | 4,
            cx: evalAnim(ms.cx, rel),
            cy: evalAnim(ms.cy, rel),
            halfW: Math.max(0, evalAnim(ms.w, rel)) / 2,
            halfH: Math.max(0, evalAnim(ms.h, rel)) / 2,
            featherIn: Math.max(0, evalAnim(ms.featherIn, rel)),
            featherOut: Math.max(0, evalAnim(ms.featherOut, rel)),
            radius: ms.radius ? Math.max(0, evalAnim(ms.radius, rel)) : 0,
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
        // alpha sources decode as colour-over-matte (2× tall) — the shader
        // splits the halves, the layer keeps its logical size
        const ap = packed?.has(clip.id) ?? false
        const half = (h: number) => (ap ? h / 2 : h)
        const layers: LayerDraw[] = [{
          source: vf as unknown as TexImageSource,
          cacheKey: clip.id,
          dynamic: true,
          alphaPacked: ap,
          srcWidth: vf.displayWidth || asset.width,
          srcHeight: half(vf.displayHeight || asset.height * (ap ? 2 : 1)),
          ...common
        }]
        const bl = blends?.get(clip.id)
        if (bl) {
          // successor frame over the main one: out = f·(A·(1−w) + B·w) over bg.
          // Exact two-pass OVER decomposition: α₁ = f(1−w)/(1−fw), α₂ = fw.
          // At f=1 this collapses to α₁=1, α₂=w — bit-identical to the old
          // opaque math. The old α₁=f overweighted A for translucent clips,
          // and since w alternates per output frame on a 30→60 fps cadence,
          // fading clips STROBED in exports (fine in the blend-less preview).
          const f = layers[0].opacity
          const fw = f * bl.w
          layers[0].opacity = fw >= 0.999999 ? 0 : (f * (1 - bl.w)) / (1 - fw)
          layers.push({
            ...layers[0],
            source: bl.frame as unknown as TexImageSource,
            cacheKey: `${clip.id}:b`,
            srcWidth: bl.frame.displayWidth || asset.width,
            srcHeight: half(bl.frame.displayHeight || asset.height * (ap ? 2 : 1)),
            opacity: fw
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
  /** the GL context died / came back — the preview cannot draw in between */
  setGpuLost(lost: boolean): void
  duration(): number
}

/** Live preview: master clock + media element sync + GPU composite. */
export class Player {
  private comp: Compositor | null = null
  private canvas: HTMLCanvasElement | null = null
  private onLost: ((e: Event) => void) | null = null
  private onRestored: (() => void) | null = null
  private pool = new MediaPool({ audio: true, proxy: true })
  private raf = 0
  /** the window whose rAF drives the loop — see schedule() */
  private view: Window = window
  private schedule: (() => void) | null = null
  private gcCounter = 0
  private wasLoading = false
  private lastDrawnProject: Project | null = null
  private lastDrawnT = -1
  private stableTicks = 0
  /** playback clock anchor — see tick() */
  private anchor: { ts: number; t: number } | null = null
  private lastSet = -1

  constructor(private hooks: PlayerHooks) {}

  /** Frame snapshots: decode originals instead of preview proxies while on. */
  setSourceQuality(on: boolean) {
    this.pool.sourceQuality = on
  }

  /** Draw the current state synchronously. Snapshots call this right before
      reading the canvas: the rAF loop is throttled (or fully parked) while
      the window is occluded, so "wait and hope a draw happened" grabbed
      stale pixels. */
  drawNow() {
    if (!this.comp) return
    const { project, playhead } = this.hooks.getState()
    drawFrame(this.comp, project, playhead, this.pool)
    this.lastDrawnProject = project
    this.lastDrawnT = playhead
  }

  attach(canvas: HTMLCanvasElement) {
    this.comp = new Compositor(canvas)
    // A GPU reset (driver hiccup, another app eating VRAM, Chromium force-losing
    // the oldest context once a renderer holds 16) turns every GL call into a
    // no-op. Left alone the preview simply goes black and STAYS black with
    // nothing to explain it, so: ask for the context back, rebuild the
    // compositor when it returns, and tell the UI while it is gone.
    this.canvas = canvas
    // grab the restore handle NOW, while the context is alive: getExtension
    // returns null on a lost context — exactly when it would be needed
    const loseExt = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context') ?? null
    this.onLost = (e: Event) => {
      e.preventDefault() // without this Chromium never offers a restore
      this.comp = null
      this.hooks.setGpuLost(true)
      // the restore must NOT be asked for from inside the lost event — Chromium
      // ignores it there (measured: the context never came back). Ask on the
      // next turn; if the GPU cannot give it back, the banner stays up.
      setTimeout(() => {
        try {
          loseExt?.restoreContext()
        } catch { /* nothing more we can do */ }
      }, 0)
    }
    this.onRestored = () => {
      // the canvas keeps the same context object, but every program, buffer
      // and texture in it is gone — a fresh Compositor rebuilds them, and its
      // texture cache starts empty so sources re-upload on the next draw
      try {
        this.comp = new Compositor(canvas)
        this.hooks.setGpuLost(false)
      } catch (err) {
        logError('превью', 'контекст GPU вернулся, но композитор не пересобрался', err)
      }
    }
    canvas.addEventListener('webglcontextlost', this.onLost)
    canvas.addEventListener('webglcontextrestored', this.onRestored)
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
          logError('превью', 'кадр не отрисовался', err)
        }
      }
      schedule()
    }
    // The clock follows the canvas, not the window it was born in: once the
    // preview is detached into its own OS window (engine/popout.ts) the
    // editor's window may be minimised, and a minimised window's rAF is
    // throttled to a crawl — playback would stall in the very window the
    // user is watching. Re-read every frame, so a move needs no notification.
    const schedule = () => {
      const v = this.canvas?.ownerDocument.defaultView
      this.view = v && !v.closed ? v : window
      this.raf = this.view.requestAnimationFrame(loop)
    }
    this.schedule = schedule
    schedule()
  }

  /** Re-aim the loop after the canvas changed windows (or its window died). */
  kick() {
    if (!this.schedule) return
    try { this.view.cancelAnimationFrame(this.raf) } catch { /* window gone */ }
    this.schedule()
  }

  detach() {
    try { this.view.cancelAnimationFrame(this.raf) } catch { /* window gone */ }
    this.schedule = null
    this.view = window
    if (this.canvas && this.onLost) this.canvas.removeEventListener('webglcontextlost', this.onLost)
    if (this.canvas && this.onRestored) this.canvas.removeEventListener('webglcontextrestored', this.onRestored)
    this.canvas = null
    this.onLost = null
    this.onRestored = null
    this.pool.dispose()
    // NB the compositor is NOT disposed: the preview canvas is reused (React
    // remounts it in dev), and Compositor.dispose kills the context a canvas
    // hands out forever — the next mount would get a dead one
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
      // Chromium throws on rates outside [0.0625, 16]; beyond the cap the
      // element free-runs at the clamped rate and the resync below keeps it
      // on the master clock with periodic seeks
      el.playbackRate = Math.min(16, Math.max(0.0625, clip.speed || 1))

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
