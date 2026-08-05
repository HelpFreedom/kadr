// Frame snapshot: grab the WYSIWYG frame at the playhead (or a given time)
// from the preview compositor, save it as a PNG next to the project file and
// import it into the media bin. Fragments in iframe-overlay mode are DOM,
// not GL — for the duration of a snapshot every active fragment is forced
// through pixel capture so the PNG matches what the export would render.
// This is also the embedded Claude's "eyes": kadr_snapshot returns the PNG
// path for it to Read.
import { useEditor } from '@/state/store'
import { dirOf } from '@shared/paths'
import { setForceCaptureAll, captureReady } from './fragmentCapture'
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

  let dir = opts.dir ?? null
  if (!dir) {
    const pp = st().projectPath
    if (pp) dir = dirOf(pp)
    else if (opts.interactive) {
      dir = await window.kadr.pickDirectory('Куда сохранить снимок кадра')
      if (!dir) throw new Error('snapshot cancelled')
    }
    // else: main falls back to Downloads
  }

  const t = opts.t ?? st().playhead
  if (Math.abs(t - st().playhead) > 1e-9) st().setPlayhead(t)

  const forced = hasFragmentsNear(t)
  if (forced) {
    // cold path: the vite fragment server may still be booting — captures
    // can't start until it answers, and reconcile retries only every 400 ms
    try { await ensureFragmentServer() } catch { /* reconcile keeps retrying */ }
    setForceCaptureAll(true)
  }
  // decode ORIGINALS for the shot: the preview normally plays 540p proxies,
  // and a snapshot at proxy quality defeats its purpose. Elements swap src
  // and re-seek; undecodable codecs (HEVC) keep their proxy.
  previewPlayer?.setSourceQuality(true)
  try {
    // give the player a tick to notice the src swaps (previewLoading rises),
    // then wait for seeks + captures, then one idle-draw period (~4 fps)
    await sleep(350)
    const deadline = Date.now() + 12000
    for (;;) {
      const ready = !st().previewLoading && (!forced || captureReady(st().project, t))
      if (ready || Date.now() > deadline) break
      await sleep(120)
    }
    await sleep(600)

    const canvas = previewCanvas
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!blob) throw new Error('canvas toBlob failed')
    const buf = await blob.arrayBuffer()

    const fps = st().project.fps
    const frame = Math.floor(t * fps + 1e-6)
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    const base = `${st().project.name || 'kadr'}_${m}m${String(s).padStart(2, '0')}s_f${frame}`
    const path = await window.kadr.saveSnapshot(dir, base, buf)

    let assetId: string | null = null
    if (opts.importToBin !== false) {
      await importFiles([path], null)
      assetId = st().project.assets.find((a) => a.path === path)?.id ?? null
    }
    return { path, assetId, width: canvas.width, height: canvas.height }
  } finally {
    previewPlayer?.setSourceQuality(false)
    if (forced) setForceCaptureAll(false)
  }
}
