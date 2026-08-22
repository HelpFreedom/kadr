// Preview proxies: heavy sources get a background adaptive 720p copy from the main
// process; the preview's MediaPool then decodes the proxy while export keeps
// reading the original (WYSIWYG quality).
import { create } from 'zustand'
import type { MediaAsset, ProxyBuildState } from '@shared/types'
import { useEditor } from '@/state/store'
import { chromiumCanDecode } from './codecs'

/** sources at or above this short-side size get a preview proxy */
const PROXY_MIN_SIDE = 720

interface ProxyProgressState {
  /** asset id → 0..1 while a proxy is being generated */
  jobs: Record<string, number>
  /** Last known lifecycle state, retained after a job completes. */
  status: Record<string, ProxyBuildState>
  /** Final error text, retained so a failed proxy is visible and retryable. */
  errors: Record<string, string>
}

export const useProxyProgress = create<ProxyProgressState>(() => ({
  jobs: {},
  status: {},
  errors: {}
}))

export function wantsProxy(a: MediaAsset): boolean {
  if (a.kind !== 'video') return false
  // codecs Chromium can't decode need a proxy at ANY size — without one the
  // preview <video> renders 0×0 and the clip is invisible
  if (!chromiumCanDecode(a.codec)) return true
  return Math.min(a.width, a.height) >= PROXY_MIN_SIDE
}

const inflight = new Set<string>()

function requestAssetProxy(a: MediaAsset, force: boolean): Promise<void> {
  if (inflight.has(a.id)) return Promise.resolve()
  inflight.add(a.id)
  useProxyProgress.setState((state) => {
    const errors = { ...state.errors }
    delete errors[a.id]
    return {
      jobs: { ...state.jobs, [a.id]: 0 },
      status: { ...state.status, [a.id]: 'queued' },
      errors
    }
  })

  const request = force
    ? window.kadr.rebuildProxy(a.path, a.duration)
    : window.kadr.requestProxy(a.path, a.duration)
  return request
    .then((proxyPath) => {
      const cur = useEditor.getState().project.assets.find((asset) => asset.id === a.id)
      if (cur && cur.proxyPath !== proxyPath) {
        useEditor.getState().updateAsset(a.id, { proxyPath })
      }
      useProxyProgress.setState((state) => ({
        status: { ...state.status, [a.id]: 'ready' }
      }))
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      useProxyProgress.setState((state) => ({
        status: { ...state.status, [a.id]: 'error' },
        errors: { ...state.errors, [a.id]: message }
      }))
      throw error
    })
    .finally(() => {
      inflight.delete(a.id)
      useProxyProgress.setState((state) => {
        const jobs = { ...state.jobs }
        delete jobs[a.id]
        return { jobs }
      })
    })
}

/** Force a fresh, validated proxy for one asset (for UI/manual recovery). */
export function rebuildProxy(assetId: string): Promise<void> {
  const asset = useEditor.getState().project.assets.find((candidate) => candidate.id === assetId)
  if (!asset || asset.kind !== 'video') return Promise.resolve()
  return requestAssetProxy(asset, true)
}

/**
 * Kick off proxy builds for every heavy asset. Safe to call repeatedly: an
 * already-built proxy resolves instantly from the main-process cache, which
 * also re-creates proxies referenced by old projects but wiped from disk.
 */
export function ensureProxies() {
  const st = useEditor.getState()
  for (const a of st.project.assets) {
    if (!wantsProxy(a) || inflight.has(a.id)) continue
    void requestAssetProxy(a, false).catch(() => { /* original remains usable; error stays in the store */ })
  }
}

let wired = false

/** Subscribe once: new assets (import or project open) get proxies queued. */
export function wireProxies() {
  if (wired) return
  wired = true
  window.kadr.onProxyProgress(({ path, progress, state, error }) => {
    const assetIds = useEditor.getState().project.assets
      .filter((asset) => asset.path === path && inflight.has(asset.id))
      .map((asset) => asset.id)
    if (!assetIds.length) return
    useProxyProgress.setState((current) => {
      const jobs = { ...current.jobs }
      const status = { ...current.status }
      const errors = { ...current.errors }
      for (const assetId of assetIds) {
        jobs[assetId] = progress
        status[assetId] = state
        if (error) errors[assetId] = error
        else if (state !== 'retrying' && state !== 'error') delete errors[assetId]
      }
      return { jobs, status, errors }
    })
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
