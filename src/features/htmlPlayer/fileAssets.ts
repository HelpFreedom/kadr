export interface FileAssetManifestEntry {
  path: string
  kind: 'image' | 'video'
  mime: string
  chunks: string[]
}

export interface FileAssetBridge {
  has(path: string): boolean
  load(path: string, signal: AbortSignal): Promise<void>
  resolveUrl(path: string): string
  destroy(): void
}

type ChunkReceiver = (
  path: string,
  index: number,
  mime: string,
  base64: string
) => void

declare global {
  interface Window {
    __kadrFileAssetChunk?: ChunkReceiver
  }
}

const TRANSPARENT_IMAGE =
  'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
const EMPTY_VIDEO = 'data:video/mp4;base64,'

function manifestEntries(): FileAssetManifestEntry[] {
  const data = document.getElementById('kadr-file-assets')
  if (!data) return []
  try {
    const value = JSON.parse(data.textContent ?? '[]') as unknown
    if (!Array.isArray(value)) return []
    return value.filter((entry): entry is FileAssetManifestEntry => {
      if (!entry || typeof entry !== 'object') return false
      const item = entry as FileAssetManifestEntry
      return typeof item.path === 'string'
        && (item.kind === 'image' || item.kind === 'video')
        && typeof item.mime === 'string'
        && Array.isArray(item.chunks)
        && item.chunks.every((chunk) => typeof chunk === 'string')
    })
  } catch {
    return []
  }
}

function decodeBase64(value: string): ArrayBuffer {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes.buffer
}

function loadScript(path: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    const cleanup = (): void => {
      script.remove()
      signal.removeEventListener('abort', aborted)
    }
    const done = (): void => {
      cleanup()
      resolve()
    }
    const failed = (): void => {
      cleanup()
      reject(new Error(`Could not load local asset chunk: ${path}`))
    }
    const aborted = (): void => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    script.async = true
    script.src = new URL(path, document.baseURI).href
    script.addEventListener('load', done, { once: true })
    script.addEventListener('error', failed, { once: true })
    signal.addEventListener('abort', aborted, { once: true })
    document.head.appendChild(script)
  })
}

/**
 * Chromium assigns every file:// URL a separate opaque origin. A sibling
 * video can therefore play as a media element, but WebGL is forbidden from
 * uploading its frames with texImage2D. Exported visual assets include small
 * classic-script chunks; loading those chunks and creating a Blob in this
 * document gives WebGL an origin-clean media URL without a local server.
 */
export function createFileAssetBridge(): FileAssetBridge {
  const enabled = location.protocol === 'file:'
  const entries = new Map(manifestEntries().map((entry) => [entry.path, entry]))
  const pieces = new Map<string, Array<ArrayBuffer | undefined>>()
  const urls = new Map<string, string>()
  const loading = new Map<string, Promise<void>>()

  const previousReceiver = window.__kadrFileAssetChunk
  const receiver: ChunkReceiver = (path, index, _mime, base64) => {
    const entry = entries.get(path)
    if (!entry || index < 0 || index >= entry.chunks.length) return
    const parts = pieces.get(path) ?? Array<ArrayBuffer | undefined>(entry.chunks.length)
    parts[index] = decodeBase64(base64)
    pieces.set(path, parts)
  }
  if (enabled) {
    window.__kadrFileAssetChunk = receiver
  }

  const load = (path: string, signal: AbortSignal): Promise<void> => {
    if (!enabled || urls.has(path)) return Promise.resolve()
    const current = loading.get(path)
    if (current) return current
    const entry = entries.get(path)
    if (!entry) return Promise.resolve()

    const promise = (async () => {
      try {
        for (const chunk of entry.chunks) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          await loadScript(chunk, signal)
        }
        const parts = pieces.get(path)
        if (!parts || parts.length !== entry.chunks.length || parts.some((part) => !part)) {
          throw new Error(`Local asset chunks are incomplete: ${path}`)
        }
        const blob = new Blob(parts as ArrayBuffer[], { type: entry.mime })
        urls.set(path, URL.createObjectURL(blob))
        pieces.delete(path)
      } catch (error) {
        pieces.delete(path)
        throw error
      }
    })()
    loading.set(path, promise)
    void promise.then(
      () => loading.delete(path),
      () => loading.delete(path)
    )
    return promise
  }

  return {
    has: (path) => enabled && entries.has(path),
    load,
    resolveUrl(path) {
      if (!enabled || !entries.has(path)) return new URL(path, document.baseURI).href
      const url = urls.get(path)
      if (url) return url
      return entries.get(path)?.kind === 'image' ? TRANSPARENT_IMAGE : EMPTY_VIDEO
    },
    destroy() {
      for (const url of urls.values()) URL.revokeObjectURL(url)
      urls.clear()
      pieces.clear()
      loading.clear()
      if (enabled && window.__kadrFileAssetChunk === receiver) {
        window.__kadrFileAssetChunk = previousReceiver
      }
    }
  }
}
