// Preview proxies: heavy sources get a background 540p copy from the main
// process; the preview's MediaPool then decodes the proxy while export keeps
// reading the original (WYSIWYG quality).
import { create } from 'zustand'
import type { MediaAsset } from '@shared/types'
import { useEditor } from '@/state/store'

/** sources at or above this short-side size get a preview proxy */
const PROXY_MIN_SIDE = 720

interface ProxyProgressState {
  /** asset id → 0..1 while a proxy is being generated */
  jobs: Record<string, number>
}

export const useProxyProgress = create<ProxyProgressState>(() => ({ jobs: {} }))

export function wantsProxy(a: MediaAsset): boolean {
  return a.kind === 'video' && Math.min(a.width, a.height) >= PROXY_MIN_SIDE
}

const inflight = new Set<string>()

/**
 * Kick off proxy builds for every heavy asset. Safe to call repeatedly: an
 * already-built proxy resolves instantly from the main-process cache, which
 * also re-creates proxies referenced by old projects but wiped from disk.
 */
export function ensureProxies() {
  const st = useEditor.getState()
  for (const a of st.project.assets) {
    if (!wantsProxy(a) || inflight.has(a.id)) continue
    inflight.add(a.id)
    useProxyProgress.setState((s) => ({ jobs: { ...s.jobs, [a.id]: 0 } }))
    window.kadr
      .requestProxy(a.path, a.duration)
      .then((proxyPath) => {
        const cur = useEditor.getState().project.assets.find((x) => x.id === a.id)
        if (cur && cur.proxyPath !== proxyPath) {
          useEditor.getState().updateAsset(a.id, { proxyPath })
        }
      })
      .catch(() => { /* preview keeps decoding the original */ })
      .finally(() => {
        inflight.delete(a.id)
        useProxyProgress.setState((s) => {
          const jobs = { ...s.jobs }
          delete jobs[a.id]
          return { jobs }
        })
      })
  }
}

let wired = false

/** Subscribe once: new assets (import or project open) get proxies queued. */
export function wireProxies() {
  if (wired) return
  wired = true
  window.kadr.onProxyProgress(({ path, progress }) => {
    const a = useEditor.getState().project.assets.find((x) => x.path === path)
    if (a && inflight.has(a.id)) {
      useProxyProgress.setState((s) => ({ jobs: { ...s.jobs, [a.id]: progress } }))
    }
  })
  let lastAssets: unknown = null
  useEditor.subscribe((s) => {
    if (s.project.assets !== lastAssets) {
      lastAssets = s.project.assets
      ensureProxies()
    }
  })
  ensureProxies()
}
