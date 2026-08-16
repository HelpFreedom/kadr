import { basename, extname, join } from 'path'
import { promises as fs } from 'fs'
import type { HtmlPlayerExportRequest, Project, VoiceoverSettings } from '@shared/types'

interface HtmlPlayerWriterOptions {
  bundlePath: string
  signal: AbortSignal
  onProgress: (progress: number) => void
  bundleFragments?: (fragmentIds: string[], outputDir: string, signal: AbortSignal) => Promise<void>
}

const PLAYER_CSS = `
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body,#kadr-player{width:100%;height:100%;margin:0;overflow:hidden;background:#080a0e;color:#eef1f6}
button,input{font:inherit}.kadr-player{position:relative;display:flex;flex-direction:column;background:#080a0e}
.kadr-stage{position:relative;flex:1;min-height:0;display:grid;place-items:center;overflow:hidden;background:#050609}
.kadr-frame{position:relative;overflow:hidden;background:#000}
.kadr-canvas{position:relative;z-index:0;display:block;width:100%;height:100%;background:#000;cursor:pointer}
.kadr-fragments{position:absolute;z-index:2;inset:0;overflow:hidden;pointer-events:none}
.kadr-fragment-frame{position:absolute;border:0;background:transparent;transform-origin:center;pointer-events:none}
.kadr-controls{display:flex;align-items:center;gap:10px;min-height:58px;padding:9px 14px;background:linear-gradient(180deg,#1d2129,#15181e);border-top:1px solid #303641;box-shadow:0 -8px 28px rgba(0,0,0,.28)}
.kadr-controls button,.kadr-big-play{display:grid;place-items:center;border:1px solid #3b424f;border-radius:7px;background:#272c35;color:#f2f4f8;cursor:pointer;transition:.15s ease}
.kadr-controls button{flex:0 0 auto;width:38px;height:36px}.kadr-controls button:hover,.kadr-big-play:hover{border-color:#4f8cff;background:#303746}
.kadr-play{width:46px!important;background:#4f8cff!important;border-color:#4f8cff!important}.kadr-current,.kadr-duration{min-width:48px;color:#c5cad3;font-variant-numeric:tabular-nums;font-size:13px}.kadr-current{text-align:right}.kadr-duration{text-align:left}
.kadr-seek{flex:1;min-width:80px;accent-color:#4f8cff}.kadr-volume{width:95px;accent-color:#4f8cff}
.kadr-big-play{position:absolute;z-index:3;width:74px;height:74px;border-radius:50%;font-size:30px;background:rgba(30,35,44,.88);box-shadow:0 12px 38px rgba(0,0,0,.42);backdrop-filter:blur(8px)}
.kadr-big-play[hidden],.kadr-loading[hidden]{display:none}.kadr-loading{position:absolute;z-index:4;right:16px;top:16px;display:flex;align-items:center;gap:9px;padding:8px 11px;border:1px solid #343b48;border-radius:8px;background:rgba(20,23,29,.86);color:#cdd2dc;font-size:12px;backdrop-filter:blur(8px)}
.kadr-loading span{width:14px;height:14px;border:2px solid #525b6d;border-top-color:#4f8cff;border-radius:50%;animation:kadr-spin .75s linear infinite}@keyframes kadr-spin{to{transform:rotate(360deg)}}
.kadr-player-error{display:grid;place-items:center;width:100%;height:100%;padding:32px;color:#ff9d9d;text-align:center;white-space:pre-wrap}
@media(max-width:640px){.kadr-controls{gap:6px;padding:7px 8px;min-height:52px}.kadr-controls button{width:34px;height:34px}.kadr-restart,.kadr-volume{display:none}.kadr-current,.kadr-duration{min-width:38px;font-size:11px}}
`

function safeName(value: string, fallback: string): string {
  const cleaned = value.replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim().slice(0, 120)
  return cleaned || fallback
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function embeddedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function embeddedScript(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script')
}

async function unusedDirectory(parent: string, baseName: string): Promise<string> {
  for (let index = 1; index < 10_000; index++) {
    const candidate = join(parent, index === 1 ? baseName : `${baseName}-${index}`)
    try {
      await fs.access(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error('Could not choose a free HTML-player directory name')
}

function clearLocalTtsPaths(settings: VoiceoverSettings): VoiceoverSettings {
  return { ...settings, modelPath: '', pythonPath: '', voicePrompt: '' }
}

function rewriteVoiceoverPaths(project: Project, assetPaths: Map<string, string>): void {
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const history = clip.voiceover
      if (!history) continue
      history.settings = clearLocalTtsPaths(history.settings)
      for (const version of history.versions) {
        version.path = assetPaths.get(version.assetId) ?? ''
        version.settings = clearLocalTtsPaths(version.settings)
      }
    }
  }
}

function indexHtml(project: Project, lang: 'ru' | 'en', playerCode: string): string {
  const title = escapeHtml(project.name)
  return `<!doctype html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>${title}</title>
  <style>${PLAYER_CSS}</style>
</head>
<body>
  <main id="kadr-player" class="kadr-player"></main>
  <script id="kadr-project" type="application/json">${embeddedJson(project)}</script>
  <script>${embeddedScript(playerCode)}</script>
</body>
</html>`
}

export async function writeHtmlPlayerExport(
  request: HtmlPlayerExportRequest,
  options: HtmlPlayerWriterOptions
): Promise<string> {
  const { signal, onProgress } = options
  const checkCancelled = (): void => {
    if (signal.aborted) throw new Error('cancelled')
  }
  checkCancelled()
  const playerCode = await fs.readFile(options.bundlePath, 'utf8')
  const project = JSON.parse(JSON.stringify(request.project)) as Project
  const folderName = `${safeName(project.name, 'kadr-project')}-html-player`
  const outputDir = await unusedDirectory(request.parentDir, folderName)
  const partialDir = `${outputDir}.partial-${process.pid}-${Date.now()}`
  const assetsDir = join(partialDir, 'assets')
  const documentsDir = join(partialDir, 'documents')
  const fragmentsDir = join(partialDir, 'fragments')
  const assetPaths = new Map<string, string>()
  const copiedSources = new Map<string, string>()
  const fragmentIds = [...new Set(project.tracks.flatMap((track) => track.clips)
    .filter((clip) => clip.kind === 'remotion' && clip.fragmentId)
    .map((clip) => clip.fragmentId!))]
  const total = Math.max(
    1,
    project.assets.length + (project.texts?.length ?? 0) + (fragmentIds.length ? 1 : 0)
  )
  let complete = 0

  try {
    await fs.mkdir(assetsDir, { recursive: true })
    if (fragmentIds.length) {
      if (!options.bundleFragments) throw new Error('Fragment bundler is unavailable')
      checkCancelled()
      await options.bundleFragments(fragmentIds, fragmentsDir, signal)
      complete++
      onProgress(complete / total)
    }
    for (let index = 0; index < project.assets.length; index++) {
      checkCancelled()
      const asset = project.assets[index]
      const source = asset.path
      let relativePath = copiedSources.get(source)
      if (!relativePath) {
        await fs.access(source)
        const ext = extname(source)
        const rawBase = basename(source, ext)
        const fileName = `${String(index + 1).padStart(4, '0')}-${safeName(rawBase, 'media')}${ext.toLowerCase()}`
        relativePath = `assets/${fileName}`
        await fs.copyFile(source, join(partialDir, relativePath))
        copiedSources.set(source, relativePath)
      }
      asset.path = relativePath
      delete asset.proxyPath
      assetPaths.set(asset.id, relativePath)
      complete++
      onProgress(complete / total)
    }

    if (project.texts?.length) await fs.mkdir(documentsDir, { recursive: true })
    for (let index = 0; index < (project.texts?.length ?? 0); index++) {
      checkCancelled()
      const doc = project.texts![index]
      const ext = extname(doc.path) || `.${doc.format}`
      const fileName = `${String(index + 1).padStart(4, '0')}-${safeName(basename(doc.path, ext), 'document')}${ext.toLowerCase()}`
      const relativePath = `documents/${fileName}`
      try {
        await fs.copyFile(doc.path, join(partialDir, relativePath))
        doc.path = relativePath
      } catch {
        doc.path = '' // optional source document is not required for playback
      }
      complete++
      onProgress(complete / total)
    }

    rewriteVoiceoverPaths(project, assetPaths)
    checkCancelled()
    await fs.writeFile(join(partialDir, 'index.html'), indexHtml(project, request.lang, playerCode), 'utf8')
    await fs.rename(partialDir, outputDir)
    onProgress(1)
    return outputDir
  } catch (error) {
    await fs.rm(partialDir, { recursive: true, force: true })
    throw error
  }
}
