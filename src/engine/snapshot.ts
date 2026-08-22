// Frame snapshots and agent storyboards: capture the WYSIWYG preview compositor
// at source quality. Remotion iframe overlays are forced through pixel capture
// so the PNGs match the rendered timeline rather than omitting DOM layers.
import { useEditor } from '@/state/store'
import { dirOf } from '@shared/paths'
import type { Project } from '@shared/types'
import { setForceCaptureAll, captureReady, getCaptureFrame } from './fragmentCapture'
import { ensureFragmentServer } from './fragments'
import { importFiles } from './mediaImport'

let previewCanvas: HTMLCanvasElement | null = null
let previewPlayer: { setSourceQuality(on: boolean): void } | null = null

/** Preview.tsx registers its GL canvas + player once the Player attaches. */
export function registerPreviewCanvas(
  c: HTMLCanvasElement | null,
  player?: { setSourceQuality(on: boolean): void } | null
) {
  previewCanvas = c
  previewPlayer = player ?? null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const fragmentIdsNear = (project: Project, t: number): string[] =>
  [...new Set(project.tracks.flatMap((track) => {
    if (track.kind !== 'video' || track.muted) return []
    return track.clips.flatMap((clip) =>
      clip.kind === 'remotion' && clip.fragmentId &&
      t >= clip.start - 2 && t < clip.start + clip.duration + 0.75
        ? [clip.fragmentId]
        : [])
  }))]

const hasFragmentsNear = (project: Project, t: number): boolean =>
  fragmentIdsNear(project, t).length > 0

export interface SnapshotResult {
  path: string
  assetId: string | null
  width: number
  height: number
}

export interface StoryboardFrame {
  t: number
  path: string
}

export interface StoryboardResult {
  contactSheetPath: string
  frames: StoryboardFrame[]
  fingerprint: string
  cached: boolean
  width: number
  height: number
}

export interface StoryboardOptions {
  start: number
  end: number
  step?: number
  maxFrames?: number
  refresh?: 'auto' | 'force'
}

interface CapturedFrame {
  t: number
  blob: Blob
  width: number
  height: number
}

// Captures mutate shared preview state, so concurrent MCP and toolbar calls must
// queue. Rejections are swallowed only on the tail promise; each caller still
// receives its own error.
let captureTail: Promise<void> = Promise.resolve()
function serializeCapture<T>(work: () => Promise<T>): Promise<T> {
  const run = captureTail.then(work, work)
  captureTail = run.then(() => undefined, () => undefined)
  return run
}

function targetDirectory(interactive: boolean, explicit?: string): Promise<string | null> | string | null {
  if (explicit) return explicit
  const projectPath = useEditor.getState().projectPath
  if (projectPath) return dirOf(projectPath)
  if (!interactive) return null // main process falls back to Downloads
  return window.kadr.pickDirectory('Куда сохранить снимок кадра')
}

/**
 * Capture several frames in one source-quality session, restoring playhead and
 * playback even when a seek, Remotion capture, or PNG encode fails.
 */
async function captureFrames(times: number[]): Promise<CapturedFrame[]> {
  const st = () => useEditor.getState()
  const canvas = previewCanvas
  if (!canvas) throw new Error('preview is not mounted')

  const originalPlayhead = st().playhead
  const originalPlaying = st().playing
  const forceFragments = times.some((t) => hasFragmentsNear(st().project, t))
  st().setPlaying(false)

  if (forceFragments) {
    try { await ensureFragmentServer() } catch { /* capture readiness below reports failure */ }
    setForceCaptureAll(true)
  }
  // This module is the sole source-quality caller. Captures are serialized, so
  // restoring false recreates the preview's pre-capture proxy mode.
  previewPlayer?.setSourceQuality(true)
  try {
    // Let source swaps reach the media elements before the first seek.
    await sleep(350)
    const out: CapturedFrame[] = []
    for (const t of times) {
      const fragmentIds = fragmentIdsNear(st().project, t)
      const previousFragmentVersions = new Map(fragmentIds.map(
        (id) => [id, getCaptureFrame(id)?.version ?? null]
      ))
      const moved = Math.abs(t - st().playhead) > 1e-9
      if (moved) st().setPlayhead(t)
      // Let the player observe the seek before checking previewLoading.
      await sleep(180)
      const deadline = Date.now() + 12000
      let ready = false
      while (Date.now() <= deadline) {
        const fragmentsAdvanced = !moved || fragmentIds.every((id) => {
          const current = getCaptureFrame(id)?.version
          const previous = previousFragmentVersions.get(id)
          return current != null && (previous == null || current > previous)
        })
        ready = !st().previewLoading &&
          (!fragmentIds.length || (captureReady(st().project, t) && fragmentsAdvanced))
        if (ready) break
        await sleep(120)
      }
      if (!ready) throw new Error(`frame at ${t.toFixed(3)}s did not become ready`)
      // One idle draw after the last media/fragment frame arrived.
      await sleep(350)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('canvas toBlob failed')
      out.push({ t, blob, width: canvas.width, height: canvas.height })
    }
    return out
  } finally {
    previewPlayer?.setSourceQuality(false)
    if (forceFragments) setForceCaptureAll(false)
    if (Math.abs(st().playhead - originalPlayhead) > 1e-9) st().setPlayhead(originalPlayhead)
    st().setPlaying(originalPlaying)
  }
}

const snapshotBase = (project: Project, t: number) => {
  const frame = Math.floor(t * project.fps + 1e-6)
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${project.name || 'kadr'}_${m}m${String(s).padStart(2, '0')}s_f${frame}`
}

/**
 * Render the timeline frame at `t` (default: current playhead) into a PNG.
 * The PNG is imported into the media bin unless `importToBin` is false.
 */
export function snapshotFrame(opts: {
  t?: number
  dir?: string
  interactive?: boolean
  importToBin?: boolean
} = {}): Promise<SnapshotResult> {
  return serializeCapture(async () => {
    const st = () => useEditor.getState()
    const chosen = await targetDirectory(!!opts.interactive, opts.dir)
    if (opts.interactive && !chosen) throw new Error('snapshot cancelled')
    const t = opts.t ?? st().playhead
    const [captured] = await captureFrames([t])
    const buf = await captured.blob.arrayBuffer()
    const path = await window.kadr.saveSnapshot(chosen, snapshotBase(st().project, t), buf)

    let assetId: string | null = null
    if (opts.importToBin !== false) {
      await importFiles([path], null)
      assetId = st().project.assets.find((asset) => asset.path === path)?.id ?? null
    }
    return { path, assetId, width: captured.width, height: captured.height }
  })
}

const MAX_STORYBOARD_FRAMES = 24

/** Build coverage-preserving timestamps for [start,end]. */
export function storyboardTimes(opts: StoryboardOptions): number[] {
  const { start, end } = opts
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('storyboard requires 0 <= start < end')
  }
  if (opts.step != null && (!Number.isFinite(opts.step) || opts.step <= 0)) {
    throw new Error('storyboard step must be positive')
  }
  const maxFrames = Math.max(1, Math.min(MAX_STORYBOARD_FRAMES, Math.floor(opts.maxFrames ?? 9)))
  if (opts.step == null) {
    if (maxFrames === 1) return [start]
    return Array.from({ length: maxFrames }, (_, i) => start + (end - start) * i / (maxFrames - 1))
  }

  const count = Math.floor((end - start) / opts.step + 1e-9) + 1
  if (count <= maxFrames) {
    return Array.from({ length: count }, (_, i) => start + i * opts.step!)
  }
  // A tiny requested step can yield millions of candidates. Sample its index
  // space directly so maxFrames remains a hard CPU/memory bound.
  if (maxFrames === 1) return [start]
  return Array.from({ length: maxFrames }, (_, i) => {
    const index = Math.round((count - 1) * i / (maxFrames - 1))
    return start + index * opts.step!
  })
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`
  ).join(',')}}`
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Visual state only: bin-only assets, waveform/poster blobs and annotations do not alter pixels. */
async function visualFingerprint(): Promise<string> {
  const state = useEditor.getState()
  const project = state.project
  const tracks = project.tracks
    .filter((track) => track.kind === 'video')
    .map((track) => ({ ...track, annotations: undefined }))
  const assetIds = new Set(tracks.flatMap((track) => track.clips.map((clip) => clip.assetId).filter(Boolean)))
  const assets = project.assets
    .filter((asset) => assetIds.has(asset.id))
    .map(({ thumbnail: _thumbnail, thumbnailEnd: _thumbnailEnd, waveform: _waveform,
      proxyPath: _proxyPath, ...asset }) => asset)
  const fragmentIds = [...new Set(tracks.flatMap((track) => track.clips
    .map((clip) => clip.fragmentId).filter((id): id is string => !!id)))].sort()
  const paths = assets.map((asset) => asset.path).sort()
  const diskApi = window.kadr as typeof window.kadr & {
    visualFingerprint?: (paths: string[], fragmentIds: string[]) => Promise<string>
  }
  // The main-process contribution observes source file mtime/size and hashes
  // each fragment folder. The renderer hash still protects cache correctness
  // on older builds, but cannot see external in-place file edits by itself.
  const disk = diskApi.visualFingerprint
    ? await diskApi.visualFingerprint(paths, fragmentIds)
    : 'renderer-only'
  return sha256(stableStringify({
    projectPath: state.projectPath,
    project: {
      id: project.id,
      width: project.width,
      height: project.height,
      fps: project.fps,
      background: project.background,
      tracks,
      assets
    },
    disk
  }))
}

function timestampLabel(t: number): string {
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`
}

async function contactSheet(captured: CapturedFrame[]): Promise<Blob> {
  const columns = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(captured.length))))
  const rows = Math.ceil(captured.length / columns)
  const cellWidth = 360
  const imageHeight = Math.max(1, Math.round(cellWidth * captured[0].height / captured[0].width))
  const labelHeight = 32
  const sheet = document.createElement('canvas')
  sheet.width = columns * cellWidth
  sheet.height = rows * (imageHeight + labelHeight)
  const ctx = sheet.getContext('2d')
  if (!ctx) throw new Error('contact sheet canvas unavailable')
  ctx.fillStyle = '#15171b'
  ctx.fillRect(0, 0, sheet.width, sheet.height)
  ctx.font = '600 18px ui-monospace, SFMono-Regular, Menlo, monospace'
  ctx.textBaseline = 'middle'

  for (let i = 0; i < captured.length; i++) {
    const frame = captured[i]
    const bitmap = await createImageBitmap(frame.blob)
    const x = (i % columns) * cellWidth
    const y = Math.floor(i / columns) * (imageHeight + labelHeight)
    ctx.drawImage(bitmap, x, y, cellWidth, imageHeight)
    bitmap.close()
    ctx.fillStyle = '#15171b'
    ctx.fillRect(x, y + imageHeight, cellWidth, labelHeight)
    ctx.fillStyle = '#f5f7fa'
    ctx.fillText(timestampLabel(frame.t), x + 10, y + imageHeight + labelHeight / 2)
  }
  const blob = await new Promise<Blob | null>((resolve) => sheet.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('contact sheet toBlob failed')
  return blob
}

const storyboardCache = new Map<string, StoryboardResult>()
const STORYBOARD_CACHE_LIMIT = 8

function rememberStoryboard(key: string, value: StoryboardResult) {
  storyboardCache.delete(key)
  storyboardCache.set(key, value)
  while (storyboardCache.size > STORYBOARD_CACHE_LIMIT) {
    const oldest = storyboardCache.keys().next().value as string | undefined
    if (!oldest) break
    storyboardCache.delete(oldest)
  }
}

/** Drop the session index. Generated PNGs remain ordinary files on disk. */
export function clearStoryboardCache() {
  storyboardCache.clear()
}

async function generateStoryboard(
  opts: StoryboardOptions,
  times: number[],
  fingerprint: string
): Promise<StoryboardResult> {
  const captured = await captureFrames(times)
  const project = useEditor.getState().project
  const tag = fingerprint.slice(0, 12)
  const cacheKey = await sha256(`${fingerprint}:${stableStringify(times)}`)
  const frames: StoryboardFrame[] = []
  for (const frame of captured) {
    const base = `${project.name || 'kadr'}_storyboard_${tag}_${snapshotBase(project, frame.t)}`
    const path = await window.kadr.saveStoryboardImage(cacheKey, base, await frame.blob.arrayBuffer())
    frames.push({ t: frame.t, path })
  }
  const sheet = await contactSheet(captured)
  const contactSheetPath = await window.kadr.saveStoryboardImage(
    cacheKey,
    `${project.name || 'kadr'}_storyboard_${tag}_${opts.start.toFixed(2)}-${opts.end.toFixed(2)}`,
    await sheet.arrayBuffer()
  )
  return {
    contactSheetPath,
    frames,
    fingerprint,
    cached: false,
    width: captured[0].width,
    height: captured[0].height
  }
}

/**
 * Generate or reuse a source-quality contact sheet plus individual PNGs.
 * `auto` reuses only an exact current visual fingerprint; `force` always
 * captures again. Files are deliberately not imported into the media bin.
 */
export function storyboardFrames(opts: StoryboardOptions): Promise<StoryboardResult> {
  return serializeCapture(async () => {
    const times = storyboardTimes(opts)
    let fingerprint = await visualFingerprint()
    const request = stableStringify({ times })
    let key = `${fingerprint}:${request}`
    if (opts.refresh !== 'force') {
      const hit = storyboardCache.get(key)
      if (hit) return { ...hit, cached: true }
    }

    let generated = await generateStoryboard(opts, times, fingerprint)
    // A long capture must not be labelled current if the project or fragment
    // sources changed while frames were being produced. Retry once; continual
    // edits then surface as a clear error instead of returning mixed old/new art.
    const after = await visualFingerprint()
    if (after !== fingerprint) {
      fingerprint = after
      key = `${fingerprint}:${request}`
      generated = await generateStoryboard(opts, times, fingerprint)
      if (await visualFingerprint() !== fingerprint) {
        throw new Error('project changed while storyboard was being captured; retry when editing pauses')
      }
    }
    rememberStoryboard(key, generated)
    return generated
  })
}
