import type { AssetKind, Project } from '@shared/types'
import type { FileAssetBridge } from './fileAssets'

interface UsageWindow {
  start: number
  end: number
}

interface PreloadEntry {
  path: string
  url: string
  kind: AssetKind | 'file'
  windows: UsageWindow[]
}

interface ConnectionInfo {
  effectiveType?: string
  saveData?: boolean
}

interface NavigatorWithConnection extends Navigator {
  connection?: ConnectionInfo
}

export interface AssetPreloader {
  prioritize(time: number): void
  destroy(): void
}

export interface FragmentAssetRef {
  path: string
  fragmentId?: string
}

function parallelLimit(): number {
  const connection = (navigator as NavigatorWithConnection).connection
  if (connection?.saveData || connection?.effectiveType?.includes('2g')) return 2
  if ((navigator.hardwareConcurrency ?? 4) >= 8) return 6
  return 4
}

function inferredKind(path: string): AssetKind | 'file' {
  const extension = path.split(/[?#]/, 1)[0].split('.').pop()?.toLowerCase()
  if (extension && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'].includes(extension)) return 'image'
  if (extension && ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'].includes(extension)) return 'audio'
  if (extension && ['mp4', 'm4v', 'webm', 'mov'].includes(extension)) return 'video'
  return 'file'
}

function entriesFor(project: Project, fragmentAssets: FragmentAssetRef[]): PreloadEntry[] {
  const windowsByAsset = new Map<string, UsageWindow[]>()
  const windowsByFragment = new Map<string, UsageWindow[]>()
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const window = { start: clip.start, end: clip.start + clip.duration }
      if (clip.assetId) {
        const windows = windowsByAsset.get(clip.assetId) ?? []
        windows.push(window)
        windowsByAsset.set(clip.assetId, windows)
      }
      if (clip.kind === 'remotion' && clip.fragmentId) {
        const windows = windowsByFragment.get(clip.fragmentId) ?? []
        windows.push(window)
        windowsByFragment.set(clip.fragmentId, windows)
      }
    }
  }

  const entries = project.assets.map((asset): PreloadEntry => ({
    path: asset.path,
    url: new URL(asset.path, document.baseURI).href,
    kind: asset.kind,
    windows: windowsByAsset.get(asset.id) ?? []
  }))
  const allFragmentWindows = [...windowsByFragment.values()].flat()
  for (const asset of fragmentAssets) {
    entries.push({
      path: asset.path,
      url: new URL(asset.path, document.baseURI).href,
      kind: inferredKind(asset.path),
      windows: asset.fragmentId ? windowsByFragment.get(asset.fragmentId) ?? [] : allFragmentWindows
    })
  }
  return [...new Map(entries.map((entry) => [entry.url, entry])).values()]
}

function priority(entry: PreloadEntry, time: number): [number, number] {
  const active = entry.windows.filter((window) => window.start <= time && window.end > time)
  if (active.length) return [0, Math.min(...active.map((window) => Math.abs(time - window.start)))]
  const future = entry.windows.filter((window) => window.start > time)
  if (future.length) return [1, Math.min(...future.map((window) => window.start - time))]
  const past = entry.windows.filter((window) => window.end <= time)
  if (past.length) return [2, Math.min(...past.map((window) => time - window.end))]
  return [3, Number.POSITIVE_INFINITY]
}

function compareAt(time: number): (left: PreloadEntry, right: PreloadEntry) => number {
  return (left, right) => {
    const a = priority(left, time)
    const b = priority(right, time)
    return a[0] - b[0] || a[1] - b[1]
      || left.url.localeCompare(right.url, undefined, { numeric: true })
  }
}

function waitForMedia(entry: PreloadEntry, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const media: HTMLImageElement | HTMLMediaElement = entry.kind === 'image'
      ? new Image()
      : document.createElement(entry.kind === 'video' ? 'video' : 'audio')
    const readyEvent = entry.kind === 'image' ? 'load' : 'canplaythrough'
    const done = (): void => {
      cleanup()
      resolve()
    }
    const fail = (): void => {
      cleanup()
      reject(new Error(`Could not preload ${entry.url}`))
    }
    const aborted = (): void => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      media.removeEventListener(readyEvent, done)
      media.removeEventListener('error', fail)
      signal.removeEventListener('abort', aborted)
      if (media instanceof HTMLMediaElement) {
        media.pause()
        media.removeAttribute('src')
        media.load()
      }
    }
    const timeout = window.setTimeout(done, 30_000)
    media.addEventListener(readyEvent, done, { once: true })
    media.addEventListener('error', fail, { once: true })
    signal.addEventListener('abort', aborted, { once: true })
    if (media instanceof HTMLMediaElement) media.preload = 'auto'
    media.src = entry.url
  })
}

function waitForFile(entry: PreloadEntry, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const link = document.createElement('link')
    const cleanup = (): void => {
      clearTimeout(timeout)
      link.remove()
      signal.removeEventListener('abort', aborted)
    }
    const done = (): void => {
      cleanup()
      resolve()
    }
    const aborted = (): void => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timeout = window.setTimeout(done, 30_000)
    signal.addEventListener('abort', aborted, { once: true })
    link.addEventListener('load', done, { once: true })
    link.addEventListener('error', done, { once: true })
    link.rel = 'preload'
    link.as = 'fetch'
    link.href = entry.url
    document.head.appendChild(link)
  })
}

async function consumeResponse(response: Response, signal: AbortSignal): Promise<void> {
  if (!response.ok) throw new Error(`Preload failed (${response.status})`)
  if (!response.body) {
    await response.blob()
    return
  }
  const reader = response.body.getReader()
  try {
    while (!signal.aborted && !(await reader.read()).done) { /* fill the browser cache */ }
  } finally {
    reader.releaseLock()
  }
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
}

async function load(
  entry: PreloadEntry,
  signal: AbortSignal,
  fileAssets?: FileAssetBridge
): Promise<void> {
  if (location.protocol === 'file:') {
    if (fileAssets?.has(entry.path)) {
      await fileAssets.load(entry.path, signal)
      return
    }
    if (entry.kind === 'file') await waitForFile(entry, signal)
    else await waitForMedia(entry, signal)
    return
  }
  try {
    await consumeResponse(await fetch(entry.url, { cache: 'force-cache', signal }), signal)
  } catch (error) {
    if (signal.aborted) throw error
    if (entry.kind === 'file') throw error
    await waitForMedia(entry, signal)
  }
}

export function createAssetPreloader(
  project: Project,
  fragmentAssets: FragmentAssetRef[],
  fileAssets?: FileAssetBridge
): AssetPreloader {
  const entries = entriesFor(project, fragmentAssets)
  const byUrl = new Map(entries.map((entry) => [entry.url, entry]))
  const finished = new Set<string>()
  const inFlight = new Map<string, AbortController>()
  const concurrency = parallelLimit()
  let target = 0
  let destroyed = false
  let reprioritizeTimer = 0

  const pending = (): PreloadEntry[] => entries
    .filter((entry) => !finished.has(entry.url))
    .sort(compareAt(target))

  const pump = (): void => {
    if (destroyed) return
    const queue = pending()
    while (inFlight.size < concurrency) {
      const entry = queue.find((candidate) => !inFlight.has(candidate.url))
      if (!entry) break
      const controller = new AbortController()
      inFlight.set(entry.url, controller)
      void load(entry, controller.signal, fileAssets).then(
        () => finished.add(entry.url),
        (error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'AbortError')) finished.add(entry.url)
        }
      ).finally(() => {
        if (inFlight.get(entry.url) === controller) inFlight.delete(entry.url)
        pump()
      })
    }
  }

  const rebuild = (): void => {
    if (destroyed) return
    const wanted = new Set(pending().slice(0, concurrency).map((entry) => entry.url))
    for (const [url, controller] of inFlight) {
      if (!wanted.has(url) && byUrl.has(url)) controller.abort()
    }
    pump()
  }

  rebuild()
  return {
    prioritize(time) {
      target = Math.max(0, time)
      window.clearTimeout(reprioritizeTimer)
      reprioritizeTimer = window.setTimeout(rebuild, 140)
    },
    destroy() {
      destroyed = true
      window.clearTimeout(reprioritizeTimer)
      for (const controller of inFlight.values()) controller.abort()
      inFlight.clear()
    }
  }
}
