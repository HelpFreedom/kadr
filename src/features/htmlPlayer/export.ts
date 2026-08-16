import type { ExportProgress, MediaAsset, Project } from '@shared/types'
import { chromiumCanDecode } from '@/engine/codecs'

const WEB_VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm'])

function extension(path: string): string {
  const clean = path.split(/[?#]/, 1)[0]
  const dot = clean.lastIndexOf('.')
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : ''
}

function browserReady(asset: MediaAsset): boolean {
  return asset.kind !== 'video' || (
    WEB_VIDEO_EXTENSIONS.has(extension(asset.path)) && chromiumCanDecode(asset.codec)
  )
}

/** Prepare browser-safe sources, then ask Electron to package the portable folder. */
export async function exportHtmlPlayer(
  sourceProject: Project,
  parentDir: string,
  lang: 'ru' | 'en',
  onProgress: (progress: ExportProgress) => void
): Promise<string> {
  const project = JSON.parse(JSON.stringify(sourceProject)) as Project
  const videos = project.assets.filter((asset) => asset.kind === 'video')
  let prepared = 0

  for (const asset of videos) {
    if (!asset.codec) {
      const probe = await window.kadr.probeMedia(asset.path)
      asset.codec = probe.asset.codec
    }
    if (!browserReady(asset)) {
      // Preview proxies are H.264/AAC MP4 and therefore work both from
      // file:// folders and ordinary web hosting. The source project stays untouched.
      const cachedProxy = asset.proxyPath && await window.kadr.statFile(asset.proxyPath)
        ? asset.proxyPath
        : null
      asset.path = cachedProxy ?? await window.kadr.requestProxy(asset.path, asset.duration)
      asset.codec = 'h264'
    }
    delete asset.proxyPath
    prepared++
    onProgress({ phase: 'files', progress: videos.length ? prepared / videos.length * 0.15 : 0.15 })
  }

  return window.kadr.htmlPlayerExport({ parentDir, project, lang })
}
