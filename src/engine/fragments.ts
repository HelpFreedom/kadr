// Remotion fragments, renderer side: dev-server handle and the create flow
// shared by the UI and the kadr MCP tool (window.kadrEditor.createFragment).
import { create } from 'zustand'
import type { FragmentInfo } from '@shared/types'
import { useEditor } from '@/state/store'

interface FragServerState {
  url: string | null
  error: string | null
}

export const useFragmentServer = create<FragServerState>(() => ({ url: null, error: null }))

let starting: Promise<string> | null = null

/** Start (or reuse) the workspace vite dev server; resolves with its URL. */
export function ensureFragmentServer(): Promise<string> {
  const cur = useFragmentServer.getState().url
  if (cur) return Promise.resolve(cur)
  if (!starting) {
    starting = window.kadr
      .fragmentServer()
      .then(({ url }) => {
        useFragmentServer.setState({ url, error: null })
        return url
      })
      .catch((err) => {
        useFragmentServer.setState({ error: String(err?.message ?? err) })
        starting = null
        throw err
      })
  }
  return starting
}

export interface CreateFragmentOpts {
  name: string
  start: number
  end: number
  /** transparent overlay (default) or opaque self-contained scene */
  transparent?: boolean
}

/**
 * Scaffold a new fragment composition sized to the project and drop its clip
 * onto the timeline at [start, end). First call may take minutes: the shared
 * workspace installs its npm dependencies once.
 */
export async function createFragment(
  opts: CreateFragmentOpts
): Promise<FragmentInfo & { clipId: string }> {
  if (!(opts.end > opts.start)) throw new Error('empty fragment range')
  const p = useEditor.getState().project
  await window.kadr.fragmentEnsure()
  const fps = Math.max(60, p.fps)
  const info = await window.kadr.fragmentCreate({
    name: opts.name,
    width: p.width,
    height: p.height,
    fps,
    durationInFrames: Math.max(1, Math.round((opts.end - opts.start) * fps)),
    transparent: opts.transparent ?? true
  })
  const clipId = useEditor
    .getState()
    .insertFragmentClip(info.id, info.meta, opts.start, opts.end - opts.start)
  void ensureFragmentServer().catch(() => { /* surfaces in the overlay */ })
  return { ...info, clipId }
}

/**
 * Delete a fragment AND every clip that references it. Deleting only the
 * workspace folder (window.kadr.fragmentDelete) leaves zombie clips whose
 * overlay shows «unknown composition» forever.
 */
export async function deleteFragment(fragmentId: string): Promise<void> {
  const st = useEditor.getState()
  const doomed = st.project.tracks
    .flatMap((t) => t.clips)
    .filter((c) => c.kind === 'remotion' && c.fragmentId === fragmentId)
    .map((c) => c.id)
  if (doomed.length) {
    st.pushHistory('hDelete')
    st.select(doomed)
    useEditor.getState().deleteSelection()
  }
  await window.kadr.fragmentDelete(fragmentId)
}
