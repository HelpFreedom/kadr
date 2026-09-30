// Frame snapshot: grab the WYSIWYG frame at the playhead (or a given time)
// from the preview compositor, save it as a PNG next to the project file and
// import it into the media bin. Fragments in iframe-overlay mode are DOM,
// not GL — for the duration of a snapshot every active fragment is forced
// through pixel capture so the PNG matches what the export would render.
// This is also the embedded Claude's "eyes": kadr_snapshot returns the PNG
// path for it to Read.
import { useEditor } from '@/state/store'
import { dirOf } from '@shared/paths'
import {
  setForceCaptureAll, captureReady, captureTargets, captureVersion, pokeCaptureSync
} from './fragmentCapture'
import { ensureFragmentServer } from './fragments'
import { importFiles } from './mediaImport'
import { logWarn } from './log'
import { token } from '@/theme'

let previewCanvas: HTMLCanvasElement | null = null
let previewPlayer: { setSourceQuality(on: boolean): void; drawNow(): void } | null = null

/** Preview.tsx registers its GL canvas + player once the Player attaches. */
export function registerPreviewCanvas(
  c: HTMLCanvasElement | null,
  player?: { setSourceQuality(on: boolean): void; drawNow(): void } | null
) {
  previewCanvas = c
  previewPlayer = player ?? null
}

/** The preview canvas (null while none is mounted) — the eyedropper's target. */
export const previewCanvasEl = () => previewCanvas

/** Redraw the preview now (after something that is not in the project changed). */
export const redrawPreview = () => previewPlayer?.drawNow()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const hasFragmentsNear = (t: number): boolean => {
  const p = useEditor.getState().project
  return p.tracks.some(
    (tr) => tr.kind === 'video' && !tr.muted && tr.clips.some(
      (c) => c.kind === 'remotion' && t >= c.start - 2 && t < c.start + c.duration + 0.75
    )
  )
}

export interface SnapshotResult {
  path: string
  assetId: string | null
  width: number
  height: number
}

/** Resolve where a snapshot goes: explicit dir, the project's folder, a
    picker (interactive, unsaved project) or null = main's Downloads fallback. */
async function snapshotDir(opts: { dir?: string; interactive?: boolean }): Promise<string | null> {
  if (opts.dir) return opts.dir
  const pp = useEditor.getState().projectPath
  if (pp) return dirOf(pp)
  if (opts.interactive) {
    const dir = await window.kadr.pickDirectory('Куда сохранить снимок кадра')
    if (!dir) throw new Error('snapshot cancelled')
    return dir
  }
  return null
}

/**
 * Shot mode around `fn`: every fragment near the requested times goes through
 * pixel capture at full width (iframe fragments are DOM, not GL) and media
 * decode their ORIGINALS instead of the 540p proxies. Undone afterwards.
 */
async function inShotMode<T>(times: number[], fn: () => Promise<T>): Promise<T> {
  if (!previewCanvas) throw new Error('preview is not mounted')
  // the canvas keeps its last good frame (preserveDrawingBuffer), so a lost
  // context would hand back that stale picture for every requested time
  if (previewCanvas.getContext('webgl2')?.isContextLost()) {
    throw new Error('GPU context lost — the preview cannot be captured until it is back')
  }
  const forced = times.some(hasFragmentsNear)
  if (forced) {
    // cold path: the vite fragment server may still be booting — captures
    // can't start until it answers, and reconcile retries only every 400 ms
    try { await ensureFragmentServer() } catch { /* reconcile keeps retrying */ }
    setForceCaptureAll(true)
  }
  previewPlayer?.setSourceQuality(true)
  try {
    return await fn()
  } finally {
    previewPlayer?.setSourceQuality(false)
    if (forced) setForceCaptureAll(false)
  }
}

/** Move to `t` and wait until the preview canvas really shows it: media
    seeked, every captured fragment on the right frame and DRAWN, then drawn
    into the compositor right now. */
async function settleAt(t: number): Promise<void> {
  const st = () => useEditor.getState()
  if (Math.abs(t - st().playhead) > 1e-9) st().setPlayhead(t)
  const forced = hasFragmentsNear(t)
  // give the player a tick to notice the src swaps (previewLoading rises),
  // then wait for seeks + captures, then one idle-draw period (~4 fps)
  await sleep(350)
  const deadline = Date.now() + 12000
  for (;;) {
    const ready = !st().previewLoading && (!forced || captureReady(st().project, t))
    if (ready || Date.now() > deadline) break
    await sleep(120)
  }
  // fragment seeks are async inside the capture window: grabbing pixels
  // before the player painted the requested frame returned STALE content
  // (bug report: snapshots showed the previous playhead's frame), and a
  // heavy 3D fragment reported the right frame long before its scene had
  // drawn anything — the snapshot came back with an empty 3D layer. The
  // query answers the frame the page has really DRAWN (player v3:
  // delayRender settled, every ThreeCanvas rendered it, two frames passed);
  // after it matches, one more paint must reach us (version bump), or the
  // frame we hold may predate it.
  if (forced) {
    const targets = captureTargets(st().project, t)
    const matchedAt = new Map<string, number>()
    const vAtMatch = new Map<string, number>()
    const fresh = new Set<string>()
    // a cold capture window of a heavy 3D fragment: modules, models,
    // geometry and shader compiles — seconds, not the old 6 s budget
    const fDeadline = Date.now() + 20000
    while (Date.now() < fDeadline && fresh.size < targets.length) {
      for (const { fragmentId, expectedFrame } of targets) {
        if (fresh.has(fragmentId)) continue
        const drawn = await window.kadr.fragmentCaptureQuery(fragmentId)
        if (drawn === expectedFrame) {
          if (!matchedAt.has(fragmentId)) {
            matchedAt.set(fragmentId, Date.now())
            vAtMatch.set(fragmentId, captureVersion(fragmentId))
          }
          const painted = captureVersion(fragmentId) > (vAtMatch.get(fragmentId) ?? 0)
          // a page with nothing left to paint sends no new frame: 500 ms
          // after a confirmed draw the frame we hold is that one
          if (painted || Date.now() - matchedAt.get(fragmentId)! > 500) fresh.add(fragmentId)
        } else {
          matchedAt.delete(fragmentId)
        }
      }
      if (fresh.size < targets.length) {
        pokeCaptureSync()
        await sleep(150)
      }
    }
    if (fresh.size < targets.length) {
      const dbg = await Promise.all(targets.map(async (x) => ({
        id: x.fragmentId, want: x.expectedFrame,
        got: await window.kadr.fragmentCaptureQuery(x.fragmentId),
        v: captureVersion(x.fragmentId)
      })))
      logWarn('снимок', `фрагменты не успели нарисовать кадр ${t.toFixed(2)} с за 20 с — снимок может быть неполным`, dbg)
    }
  }
  await sleep(forced ? 250 : 600)
  // the preview rAF loop may be throttled to a standstill while the window
  // is occluded — never rely on it having drawn: composite the frame NOW
  previewPlayer?.drawNow()
}

const pngOf = async (canvas: HTMLCanvasElement): Promise<ArrayBuffer> => {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('canvas toBlob failed')
  return blob.arrayBuffer()
}

const stamp = (t: number, fps: number) => {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}m${String(s).padStart(2, '0')}s_f${Math.floor(t * fps + 1e-6)}`
}

/**
 * Render the timeline frame at `t` (default: current playhead) into a PNG.
 * dir: target directory; defaults to the project file's directory. When the
 * project was never saved: `interactive` (the toolbar button) asks with a
 * native picker, non-interactive callers (kadr_snapshot) fall back to
 * Downloads. The PNG is imported into the media bin unless `importToBin`
 * is false.
 */
export async function snapshotFrame(opts: {
  t?: number
  dir?: string
  interactive?: boolean
  importToBin?: boolean
} = {}): Promise<SnapshotResult> {
  const st = () => useEditor.getState()
  if (!previewCanvas) throw new Error('preview is not mounted')
  const dir = await snapshotDir(opts)
  const t = opts.t ?? st().playhead
  return inShotMode([t], async () => {
    await settleAt(t)
    const canvas = previewCanvas!
    const buf = await pngOf(canvas)
    const base = `${st().project.name || 'kadr'}_${stamp(t, st().project.fps)}`
    const path = await window.kadr.saveSnapshot(dir, base, buf)
    let assetId: string | null = null
    if (opts.importToBin !== false) {
      await importFiles([path], null)
      assetId = st().project.assets.find((a) => a.path === path)?.id ?? null
    }
    return { path, assetId, width: canvas.width, height: canvas.height }
  })
}

export interface SheetResult {
  path: string
  width: number
  height: number
  frames: { t: number; x: number; y: number; w: number; h: number; label: string }[]
}

/**
 * Contact sheet: several WYSIWYG frames in ONE picture, each labelled with
 * its time (and bar.beat when the timeline has an analysed beat grid) — the
 * way to check a sequence, the middles of transitions or the seams between
 * fragments at a glance. Same path as a snapshot (fragments through pixel
 * capture at full width, originals decoded), never imported into the bin.
 * `width` is the width of ONE frame in the sheet (default 480).
 */
export async function contactSheet(opts: {
  times: number[]
  cols?: number
  width?: number
  dir?: string
}): Promise<SheetResult> {
  const st = () => useEditor.getState()
  if (!previewCanvas) throw new Error('preview is not mounted')
  const times = (opts.times ?? []).filter((t) => Number.isFinite(t) && t >= 0)
  if (!times.length) throw new Error('contactSheet: no times')
  if (times.length > 48) throw new Error('contactSheet: at most 48 frames per sheet')
  const dir = await snapshotDir({ dir: opts.dir })
  const p = st().project
  const cols = Math.max(1, Math.min(times.length, Math.round(opts.cols ?? Math.min(4, times.length))))
  const rows = Math.ceil(times.length / cols)
  const fw = Math.max(120, Math.min(p.width, Math.round(opts.width ?? 480)))
  const fh = Math.round(fw * (p.height / p.width))
  const label = Math.max(14, Math.round(fw / 26))
  const pad = Math.round(label * 0.6)
  const cellH = fh + label + pad * 2
  const sheet = document.createElement('canvas')
  sheet.width = cols * fw + (cols + 1) * pad
  sheet.height = rows * cellH + pad
  const g = sheet.getContext('2d')!
  g.fillStyle = token('--c-bg-0', 'black')
  g.fillRect(0, 0, sheet.width, sheet.height)
  const saved = st().playhead
  const frames: SheetResult['frames'] = []
  await inShotMode(times, async () => {
    for (let i = 0; i < times.length; i++) {
      const t = times[i]
      await settleAt(t)
      const x = pad + (i % cols) * (fw + pad)
      const y = pad + Math.floor(i / cols) * cellH
      g.drawImage(previewCanvas!, x, y, fw, fh)
      const text = sheetLabel(t, p.fps)
      g.fillStyle = token('--c-text-2', 'white')
      g.font = `${label}px ui-monospace, "DejaVu Sans Mono", monospace`
      g.textBaseline = 'top'
      g.fillText(text, x, y + fh + Math.round(pad / 2))
      frames.push({ t, x, y, w: fw, h: fh, label: text })
    }
  })
  st().setPlayhead(saved)
  const buf = await pngOf(sheet)
  const base = `${p.name || 'kadr'}_sheet_${stamp(times[0], p.fps)}_${times.length}`
  const path = await window.kadr.saveSnapshot(dir, base, buf)
  return { path, width: sheet.width, height: sheet.height, frames }
}

/** "0:42.40 · f2544" plus "· такт 17.3" when beat markers carry bars. */
function sheetLabel(t: number, fps: number): string {
  const m = Math.floor(t / 60)
  const s = (t - m * 60).toFixed(2).padStart(5, '0')
  let out = `${m}:${s} · f${Math.floor(t * fps + 1e-6)}`
  const beats = (useEditor.getState().project.markers ?? [])
    .filter((mk) => mk.kind === 'beat' && typeof (mk as { bar?: number }).bar === 'number' && mk.time <= t + 1e-6)
  const last = beats.length ? beats.reduce((a, b) => (b.time > a.time ? b : a)) : null
  if (last) {
    const b = last as { bar?: number; beatInBar?: number }
    out += ` · такт ${b.bar}.${b.beatInBar ?? 1}`
  }
  return out
}

/**
 * WYSIWYG pixels of several frames (project resolution, RGBA) — the same path
 * as a snapshot, for checks that measure the picture (contrast of captions,
 * seams between fragments). The playhead is put back afterwards.
 */
export async function framePixels(times: number[]): Promise<ImageData[]> {
  if (!previewCanvas) throw new Error('preview is not mounted')
  const st = () => useEditor.getState()
  const saved = st().playhead
  const out: ImageData[] = []
  const c = document.createElement('canvas')
  try {
    await inShotMode(times, async () => {
      for (const t of times) {
        await settleAt(t)
        const src = previewCanvas!
        c.width = src.width
        c.height = src.height
        const g = c.getContext('2d', { willReadFrequently: true })!
        g.clearRect(0, 0, c.width, c.height)
        g.drawImage(src, 0, 0)
        out.push(g.getImageData(0, 0, c.width, c.height))
      }
    })
  } finally {
    st().setPlayhead(saved)
  }
  return out
}
