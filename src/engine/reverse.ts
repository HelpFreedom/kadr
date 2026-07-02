// Clip reversal: the used source range is rendered backwards by ffmpeg into
// a cached file (userData/reversed), registered as a new asset marked with
// `reverseOf`, and the clip (plus its linked AV twin) is retargeted to it.
// Reversing a clip that already sits on a reversed asset flips it back to
// the original without re-encoding. Preview and export treat the result as
// ordinary media — effects, transitions and the audio mix all apply.
import { create } from 'zustand'
import { useEditor, uid, findClip } from '@/state/store'
import type { Clip, MediaAsset, Project } from '@shared/types'

/** clip id → render progress 0..1 for reversals in flight (timeline shows ⏳ N%) */
export const useReverseUi = create<{ busy: Record<string, number> }>(() => ({ busy: {} }))

const setBusy = (ids: string[], value: number | null) =>
  useReverseUi.setState((s) => {
    const busy = { ...s.busy }
    for (const id of ids) value === null ? delete busy[id] : (busy[id] = value)
    return { busy }
  })

/** the clip and its linked twin that sit on the same asset */
function groupOf(project: Project, clip: Clip): Clip[] {
  if (!clip.linkId) return [clip]
  const out: Clip[] = []
  for (const t of project.tracks)
    for (const c of t.clips)
      if (c.linkId === clip.linkId && c.assetId === clip.assetId) out.push(c)
  return out.length ? out : [clip]
}

/** source seconds actually consumed by the clip (first loop iteration) */
const playedSpan = (c: Clip) => c.duration * (c.speed || 1)

export async function reverseClip(clipId: string): Promise<void> {
  const st = useEditor.getState()
  const found = findClip(st.project, clipId)
  if (!found || found.clip.kind !== 'media' || !found.clip.assetId) return
  const clip = found.clip
  const asset = st.project.assets.find((a) => a.id === clip.assetId)
  if (!asset || asset.kind === 'image' || !asset.duration) return
  const group = groupOf(st.project, clip)

  // already reversed → retarget back to the original (lossless, instant)
  if (asset.reverseOf) {
    const orig = st.project.assets.find((a) => a.id === asset.reverseOf!.assetId)
    if (orig) {
      const { start, duration } = asset.reverseOf
      st.pushHistory('hReverse')
      for (const c of group) {
        const inPoint = Math.max(0, start + duration - (c.inPoint + playedSpan(c)))
        useEditor.getState().updateClip(c.id, { assetId: orig.id, inPoint })
      }
      return
    }
    // original asset left the project — fall through and reverse the render
  }

  // union of the source ranges used by the group
  let s = Infinity
  let e = 0
  for (const c of group) {
    s = Math.min(s, c.inPoint)
    e = Math.max(e, c.inPoint + playedSpan(c))
  }
  s = Math.max(0, s)
  e = Math.min(asset.duration, e)
  const dur = e - s
  if (dur < 0.05) return

  const ids = group.map((c) => c.id)
  // a repeat click while the render is running must not queue a duplicate
  if (ids.some((cid) => useReverseUi.getState().busy[cid] !== undefined)) return
  setBusy(ids, 0)
  const offProgress = window.kadr.onReverseProgress((p) => {
    if (p.path === asset.path && Math.abs(p.start - s) < 0.002 && Math.abs(p.duration - dur) < 0.002)
      setBusy(ids, p.progress)
  })
  try {
    const path = await window.kadr.reverseMedia(asset.path, s, dur, {
      kind: asset.kind,
      hasAudio: asset.hasAudio,
      width: asset.width,
      height: asset.height,
      fps: asset.fps
    })
    const { asset: probed } = await window.kadr.probeMedia(path)
    const rev: MediaAsset = {
      id: uid(),
      ...probed,
      name: `${asset.name} ⏪`,
      reverseOf: { assetId: asset.id, start: s, duration: dur }
    }
    const cur = useEditor.getState()
    if (!findClip(cur.project, clipId)) return // clip vanished while rendering
    cur.pushHistory('hReverse')
    cur.addAsset(rev)
    for (const c of group) {
      const inPoint = Math.max(0, s + dur - (c.inPoint + playedSpan(c)))
      useEditor.getState().updateClip(c.id, { assetId: rev.id, inPoint })
    }
  } finally {
    offProgress()
    setBusy(ids, null)
  }
}
