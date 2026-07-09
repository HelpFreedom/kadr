import { create } from 'zustand'
import { useEditor, uid } from '@/state/store'
import type { TextDoc } from '@shared/types'

/** files/URLs currently being imported (drop or dialog) — drives the '…' hint */
export const useImportUi = create<{ active: number }>(() => ({ active: 0 }))

/**
 * Import files by absolute path: probe each into a bin asset (paths already
 * in the bin are reused, not duplicated), register srt/txt as text docs, and
 * — when `at` is given — lay the media out back-to-back on the timeline from
 * that point (one undo entry; audio lands on an audio track).
 * Used by the Import dialog and by OS drag-and-drop onto the bin/timeline.
 */
export async function importFiles(
  paths: string[],
  place: { trackId: string | null; at: number } | null
): Promise<string[]> {
  useImportUi.setState((s) => ({ active: s.active + 1 }))
  try {
    return await importFilesInner(paths, place)
  } finally {
    useImportUi.setState((s) => ({ active: s.active - 1 }))
  }
}

async function importFilesInner(
  paths: string[],
  place: { trackId: string | null; at: number } | null
): Promise<string[]> {
  const st = useEditor.getState
  const assetIds: string[] = []
  const textDocs: TextDoc[] = []
  for (const path of paths) {
    const ext = path.split('.').pop()?.toLowerCase()
    if (ext === 'srt' || ext === 'txt') {
      textDocs.push({
        id: uid(),
        name: path.split('/').pop()!,
        path,
        format: ext as 'srt' | 'txt'
      })
      continue
    }
    const existing = st().project.assets.find((a) => a.path === path)
    if (existing) {
      assetIds.push(existing.id)
      continue
    }
    try {
      const { asset } = await window.kadr.probeMedia(path)
      const id = uid()
      st().addAsset({ id, ...asset })
      assetIds.push(id)
    } catch (err) {
      console.error('probe failed', path, err)
    }
  }
  if (textDocs.length) st().addTexts(textDocs)
  if (place && assetIds.length) {
    st().insertClipsFromAssets(assetIds, place.trackId, place.at)
  }
  return assetIds
}

export interface DropPayload {
  /** absolute local paths (dropped files / file:// URIs) */
  paths: string[]
  /** remote http(s) or data: URLs (an image dragged out of a browser) */
  urls: string[]
  /** path-less File objects (image data dragged between apps) */
  blobs: File[]
  /** XDG FileTransfer portal key (GTK apps / sandboxed browsers) */
  portalKey: string
}

/**
 * Extract everything importable from a drop, synchronously — dataTransfer is
 * only readable during the event (File objects stay readable after it).
 * Files come via webUtils; file managers that pass only text/uri-list,
 * browser image drags (URL / data: / path-less File) land in the fallbacks.
 */
export function dropPayload(e: { dataTransfer: DataTransfer }): DropPayload {
  const paths: string[] = []
  const blobs: File[] = []
  for (const f of Array.from(e.dataTransfer.files)) {
    const p = window.kadr.pathForFile(f)
    if (p) paths.push(p)
    else blobs.push(f) // no backing path — carry the content itself
  }
  const urls: string[] = []
  // x-moz-url (Firefox/Camoufox) alternates URL and title lines — the
  // non-URL title lines simply don't match the prefixes below; Chrome's
  // DownloadURL carries "mime:name:url" for download-shelf drags
  const downloadUrl = e.dataTransfer.getData('DownloadURL') || ''
  const uriList = [
    e.dataTransfer.getData('text/uri-list') ||
    e.dataTransfer.getData('text/x-moz-url') ||
    e.dataTransfer.getData('text/plain') || '',
    downloadUrl.split(':').slice(2).join(':')
  ].join('\n')
  for (const line of uriList.split(/\r?\n/)) {
    const u = line.trim()
    if (!u || u.startsWith('#')) continue
    if (u.startsWith('file://')) {
      if (paths.length) continue // already covered by dataTransfer.files
      try { paths.push(decodeURIComponent(new URL(u).pathname)) } catch { /* malformed */ }
    } else if (/^https?:\/\//i.test(u) || /^data:(image|video|audio)\//i.test(u)) {
      urls.push(u)
    }
  }
  // XDG portal file transfer (GTK apps, sandboxed browsers): the drop only
  // carries a key; the actual paths are fetched from the portal in main
  const portalKey =
    (e.dataTransfer.getData('application/vnd.portal.filetransfer') || '').trim()
  return { paths, urls, blobs, portalKey }
}

/** Anything importable in this drag? (drop targets use it to preventDefault) */
export function dragHasMedia(e: { dataTransfer: DataTransfer }): boolean {
  const t = e.dataTransfer.types
  return t.includes('Files') || t.includes('text/uri-list') ||
    t.includes('text/x-moz-url') || t.includes('DownloadURL') ||
    t.includes('application/vnd.portal.filetransfer')
}

/** Is there anything for importDrop to work with? */
export function dropUsable(p: DropPayload): boolean {
  return p.paths.length > 0 || p.urls.length > 0 || p.blobs.length > 0 || !!p.portalKey
}

/**
 * Import a drop. Priority: real files → URLs (the original the browser
 * linked to; downloaded by main into userData/imported, cached) → raw file
 * content (saved by main into the same place). URLs win over blobs so a
 * browser drag that carries both doesn't import twice.
 */
export async function importDrop(
  payload: DropPayload,
  place: { trackId: string | null; at: number } | null
): Promise<void> {
  useImportUi.setState((s) => ({ active: s.active + 1 }))
  try {
    const paths = [...payload.paths]
    if (!paths.length && payload.portalKey) {
      try {
        paths.push(...await window.kadr.portalFiles(payload.portalKey))
      } catch (err) {
        console.error('kadr-drop: portal transfer failed', err)
      }
    }
    if (!paths.length) {
      for (const url of payload.urls) {
        try {
          if (url.startsWith('data:')) {
            const blob = await (await fetch(url)).blob()
            const data = new Uint8Array(await blob.arrayBuffer())
            if (data.length) paths.push(await window.kadr.saveBlobMedia('dropped', blob.type, data))
          } else {
            paths.push(await window.kadr.downloadMedia(url))
          }
        } catch (err) {
          console.error('kadr-drop: url import failed', url, err)
        }
      }
      if (!paths.length) {
        for (const f of payload.blobs) {
          try {
            const data = new Uint8Array(await f.arrayBuffer())
            if (data.length) paths.push(await window.kadr.saveBlobMedia(f.name, f.type, data))
          } catch (err) {
            console.error('kadr-drop: blob import failed', f.name, err)
          }
        }
      }
    }
    if (paths.length) await importFilesInner(paths, place)
    else console.warn('kadr-drop: nothing importable in this drop')
  } finally {
    useImportUi.setState((s) => ({ active: s.active - 1 }))
  }
}

/**
 * Forensics for real-world drags (file managers and browsers differ wildly
 * in what they put on the wire): every drop is summarized to the console and
 * kept in window.__dragLog — readable over CDP when a user reports a drop
 * that "did nothing".
 */
export function wireDropDiagnostics() {
  const log: unknown[] = []
  ;(window as unknown as { __dragLog: unknown[] }).__dragLog = log
  window.addEventListener('drop', (e) => {
    const dt = e.dataTransfer
    if (!dt) return
    const entry = {
      t: new Date().toISOString(),
      target: String((e.target as HTMLElement)?.className ?? '').slice(0, 60),
      types: [...dt.types],
      files: Array.from(dt.files).map((f) => ({
        name: f.name, type: f.type, size: f.size,
        hasPath: !!window.kadr.pathForFile(f)
      })),
      uri: (dt.getData('text/uri-list') || dt.getData('text/x-moz-url') ||
            dt.getData('text/plain') || '').slice(0, 300),
      downloadUrl: (dt.getData('DownloadURL') || '').slice(0, 200),
      portalKey: dt.getData('application/vnd.portal.filetransfer') || ''
    }
    log.push(entry)
    if (log.length > 20) log.shift()
    console.log('kadr-drop', JSON.stringify(entry))
    try { window.kadr.dropLog(entry) } catch { /* diagnostics only */ }
  }, true)
}
