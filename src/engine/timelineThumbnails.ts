import { useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, KadrApi, MediaAsset, TimelineThumbnailFrame } from '@shared/types'

const TARGET_TILE_PX = 92
const REQUEST_WIDTH = 160
const REQUEST_HEIGHT = 90
const REQUEST_DEBOUNCE_MS = 140
const REMOTION_FINGERPRINT_POLL_MS = 3_000
const MAX_CACHE_ENTRIES = 800
const MAX_CONCURRENT_REQUESTS = 2

// Stable density levels keep both renderer and disk caches useful while zooming.
// The 1-2-3-5 sequence stays close to one thumbnail per 80-100 CSS pixels.
const STEP_LEVELS = [
  1 / 30, 1 / 20, 0.1, 0.2, 0.3, 0.5,
  1, 2, 3, 5, 10, 20, 30, 60, 120, 300
]

type TimelineThumbnailApi = Partial<Pick<KadrApi, 'timelineThumbnails' | 'visualFingerprint'>>

export interface TimelineThumbnailTile {
  /** Timeline position relative to the start of the clip. */
  localTime: number
  /** Width of the tile in timeline seconds. */
  duration: number
  /** Rendered thumbnail data URL. */
  url: string
  /** Stable React key across viewport changes. */
  key: string
}

interface UseTimelineThumbnailsOptions {
  clip: Clip
  asset?: MediaAsset
  zoom: number
  viewStart: number
  viewEnd: number
  enabled: boolean
}

interface Sample {
  localTime: number
  sourceTime: number
  duration: number
}

interface ScheduledJob {
  cancelled: boolean
  run: () => Promise<void>
}

const frameCache = new Map<string, string>()
const requestQueue: ScheduledJob[] = []
let activeRequests = 0

function putCached(key: string, value: string): void {
  // Map insertion order is a compact LRU approximation. Refresh cache hits so
  // frames around the current viewport survive longer than abandoned zooms.
  frameCache.delete(key)
  frameCache.set(key, value)
  while (frameCache.size > MAX_CACHE_ENTRIES) {
    const oldest = frameCache.keys().next().value as string | undefined
    if (!oldest) break
    frameCache.delete(oldest)
  }
}

function getCached(key: string): string | undefined {
  const value = frameCache.get(key)
  if (!value) return undefined
  frameCache.delete(key)
  frameCache.set(key, value)
  return value
}

function pumpQueue(): void {
  while (activeRequests < MAX_CONCURRENT_REQUESTS) {
    const job = requestQueue.shift()
    if (!job) return
    if (job.cancelled) continue
    activeRequests += 1
    void job.run().finally(() => {
      activeRequests -= 1
      pumpQueue()
    })
  }
}

function schedule(run: () => Promise<void>): () => void {
  const job: ScheduledJob = { cancelled: false, run }
  requestQueue.push(job)
  pumpQueue()
  return () => {
    job.cancelled = true
  }
}

function densityStep(zoom: number): number {
  const desired = TARGET_TILE_PX / Math.max(1, zoom)
  let best = STEP_LEVELS[0]
  let bestDistance = Infinity
  for (const step of STEP_LEVELS) {
    const distance = Math.abs(Math.log(step / desired))
    if (distance < bestDistance) {
      best = step
      bestDistance = distance
    }
  }
  return best
}

function frameTime(time: number, fps: number, sourceDuration: number): number {
  const safeFps = Number.isFinite(fps) && fps > 0 ? fps : 30
  const lastFrame = Math.max(0, sourceDuration - 1 / safeFps)
  const aligned = Math.min(lastFrame, Math.max(0, Math.round(time * safeFps) / safeFps))
  // The IPC boundary normalizes requests to milliseconds; mirror that here so
  // response times address the exact same memory-cache entries.
  return Math.round(aligned * 1000) / 1000
}

function timeKey(time: number): string {
  return time.toFixed(6)
}

function sourceInfo(clip: Clip, asset?: MediaAsset): {
  kind: 'media' | 'remotion'
  source: string
  duration: number
  fps: number
  requestIdentity: string
} | null {
  if (clip.kind === 'remotion' && clip.fragmentId) {
    const meta = clip.fragmentMeta
    const fps = meta?.fps || 30
    const duration = meta ? meta.durationInFrames / fps : Math.max(0.05, clip.duration * (clip.speed || 1))
    const version = meta
      ? `${meta.width}x${meta.height}:${meta.fps}:${meta.durationInFrames}:${meta.transparent ? 1 : 0}`
      : 'live'
    return {
      kind: 'remotion', source: clip.fragmentId, duration, fps,
      requestIdentity: `remotion:${clip.fragmentId}:${version}`
    }
  }
  if (clip.kind === 'media' && asset?.kind === 'video') {
    const sourcePath = asset.proxyPath ?? asset.path
    return {
      kind: 'media', source: sourcePath, duration: asset.duration, fps: asset.fps || 30,
      requestIdentity: `media:${asset.id}:${sourcePath}:${asset.duration}:${asset.fps}`
    }
  }
  return null
}

function makeSamples(
  clip: Clip,
  sourceDuration: number,
  fps: number,
  zoom: number,
  viewStart: number,
  viewEnd: number
): { step: number; samples: Sample[] } {
  const step = densityStep(zoom)
  // One extra tile on either side prevents a blank flash during a small scroll.
  const from = Math.max(0, viewStart - clip.start - step)
  const to = Math.min(clip.duration, viewEnd - clip.start + step)
  if (to <= from || clip.duration * zoom < 24) return { step, samples: [] }

  const speed = clip.speed || 1
  const sourceStart = Math.min(Math.max(0, clip.inPoint), Math.max(0, sourceDuration))
  const sourceSpan = Math.max(1 / Math.max(1, fps), sourceDuration - sourceStart)
  const first = Math.max(0, Math.floor(from / step) * step)
  const samples: Sample[] = []
  for (let localTime = first; localTime < to + 1e-8; localTime += step) {
    // Sample the centre of the actual tile. When a whole short clip fits in a
    // coarse tile, using step / 2 would clamp to the very last source frame;
    // some containers cannot seek to that rounded end timestamp reliably.
    const tileDuration = Math.min(step, clip.duration - localTime)
    const sampleAt = localTime + tileDuration / 2
    if (sampleAt < 0) continue
    const offset = ((sampleAt * speed) % sourceSpan + sourceSpan) % sourceSpan
    samples.push({
      localTime,
      sourceTime: frameTime(sourceStart + offset, fps, sourceDuration),
      duration: tileDuration
    })
  }
  return { step, samples }
}

/**
 * Load an adaptive, viewport-limited timeline filmstrip. Existing coarse tiles
 * remain mounted until a finer density is complete, avoiding flashes on zoom.
 */
export function useTimelineThumbnails({
  clip, asset, zoom, viewStart, viewEnd, enabled
}: UseTimelineThumbnailsOptions): TimelineThumbnailTile[] {
  const source = useMemo(
    () => sourceInfo(clip, asset),
    [asset, clip.fragmentId, clip.fragmentMeta, clip.kind]
  )
  const [visualVersion, setVisualVersion] = useState<{ source: string; value: string } | null>(null)
  const [result, setResult] = useState<{ mappingKey: string; tiles: TimelineThumbnailTile[] }>({
    mappingKey: '', tiles: []
  })
  const generation = useRef(0)

  const api = window.kadr as typeof window.kadr & TimelineThumbnailApi
  const visible = enabled && viewEnd > clip.start && viewStart < clip.start + clip.duration
  const needsFingerprint = source?.kind === 'remotion' && !!api.visualFingerprint
  const fingerprintReady = !needsFingerprint || visualVersion?.source === source?.source
  const versionedIdentity = source && visualVersion?.source === source.source
    ? `${source.requestIdentity}:${visualVersion.value}`
    : source?.requestIdentity ?? ''
  const mappingKey = source
    ? `${versionedIdentity}:${clip.inPoint}:${clip.speed || 1}:${clip.duration}`
    : ''

  useEffect(() => {
    const fingerprint = api.visualFingerprint
    if (!visible || source?.kind !== 'remotion' || !fingerprint) return
    let alive = true
    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      try {
        const value = await fingerprint([], [source.source])
        if (alive) setVisualVersion((previous) =>
          previous?.source === source.source && previous.value === value
            ? previous
            : { source: source.source, value }
        )
      } catch {
        // Thumbnail generation remains available even if invalidation probing fails.
        if (alive) setVisualVersion((previous) => previous?.source === source.source
          ? previous
          : { source: source.source, value: 'unversioned' })
      } finally {
        checking = false
      }
    }
    void check()
    const timer = window.setInterval(() => { void check() }, REMOTION_FINGERPRINT_POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [api.visualFingerprint, source?.kind, source?.source, visible])

  useEffect(() => {
    const currentGeneration = ++generation.current
    if (!visible || !source || !fingerprintReady) return
    const requestThumbnails = api.timelineThumbnails
    if (!requestThumbnails) return

    const { samples } = makeSamples(
      clip, source.duration, source.fps, zoom, viewStart, viewEnd
    )
    if (!samples.length) return

    const cachePrefix = `${versionedIdentity}:${REQUEST_WIDTH}x${REQUEST_HEIGHT}`
    const cacheKeyFor = (time: number) => `${cachePrefix}:${timeKey(time)}`
    const cachedTiles = samples.map((sample): TimelineThumbnailTile | null => {
      const url = getCached(cacheKeyFor(sample.sourceTime))
      return url ? {
        localTime: sample.localTime,
        duration: sample.duration,
        url,
        key: `${mappingKey}:${sample.localTime.toFixed(6)}`
      } : null
    })
    if (cachedTiles.every((tile): tile is TimelineThumbnailTile => tile !== null)) {
      setResult({ mappingKey, tiles: cachedTiles })
      return
    }

    let cancelScheduled: (() => void) | undefined
    const timer = window.setTimeout(() => {
      const missingTimes = [...new Set(samples
        .filter((sample) => !frameCache.has(cacheKeyFor(sample.sourceTime)))
        .map((sample) => sample.sourceTime))]
      if (!missingTimes.length) {
        const tiles = samples.flatMap((sample): TimelineThumbnailTile[] => {
          const url = getCached(cacheKeyFor(sample.sourceTime))
          return url ? [{
            localTime: sample.localTime,
            duration: sample.duration,
            url,
            key: `${mappingKey}:${sample.localTime.toFixed(6)}`
          }] : []
        })
        if (currentGeneration === generation.current && tiles.length) {
          setResult({ mappingKey, tiles })
        }
        return
      }
      cancelScheduled = schedule(async () => {
        if (currentGeneration !== generation.current) return
        try {
          const frames: TimelineThumbnailFrame[] = []
          // The native side intentionally caps one request at 32 frames. Wide
          // displays can need a few more, so keep them in one queued job but
          // send bounded batches.
          for (let offset = 0; offset < missingTimes.length; offset += 32) {
            if (currentGeneration !== generation.current) return
            frames.push(...await requestThumbnails({
              kind: source.kind,
              ...(source.kind === 'media'
                ? { sourcePath: source.source }
                : { fragmentId: source.source }),
              times: missingTimes.slice(offset, offset + 32),
              width: REQUEST_WIDTH,
              height: REQUEST_HEIGHT,
              cacheKey: versionedIdentity
            }))
          }
          if (currentGeneration !== generation.current) return
          for (const frame of frames) {
            if (frame.dataUrl) putCached(cacheKeyFor(frame.time), frame.dataUrl)
          }
          const tiles = samples.flatMap((sample): TimelineThumbnailTile[] => {
            const url = getCached(cacheKeyFor(sample.sourceTime))
            return url ? [{
              localTime: sample.localTime,
              duration: sample.duration,
              url,
              key: `${mappingKey}:${sample.localTime.toFixed(6)}`
            }] : []
          })
          // A sparse/failed response must not replace a complete coarse strip.
          if (tiles.length > 0) setResult({ mappingKey, tiles })
        } catch {
          // Existing start/end posters (or the previous coarse strip) remain.
        }
      })
    }, REQUEST_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      cancelScheduled?.()
    }
  }, [
    api.timelineThumbnails, asset, clip, fingerprintReady, mappingKey, source,
    versionedIdentity, viewEnd, viewStart, visible, zoom
  ])

  return result.mappingKey === mappingKey ? result.tiles : []
}
