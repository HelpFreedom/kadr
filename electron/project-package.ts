import { ZipArchive } from 'archiver'
import { createWriteStream } from 'fs'
import { promises as fs } from 'fs'
import {
  basename, dirname, isAbsolute, join, relative, resolve, sep
} from 'path'
import type { Project, ProjectPackageOptions, ProjectPackageResult } from '@shared/types'
import { copyProjectFragments, restoreProjectFragments } from './fragments'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

function safeName(value: string, fallback: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || fallback
}

function pathIsAbsolute(value: string): boolean {
  return isAbsolute(value) || /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)
}

function resolveStoredPath(value: string, projectPath: string): string {
  if (!value || pathIsAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value
  return resolve(dirname(projectPath), value)
}

function insideProject(value: string, projectPath: string): string {
  if (!value || !pathIsAbsolute(value)) return value
  const rel = relative(dirname(projectPath), value)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || pathIsAbsolute(rel)) return value
  return rel.split(sep).join('/')
}

function mapProjectPaths(project: Project, map: (path: string) => string): Project {
  const next = clone(project)
  for (const asset of next.assets) {
    asset.path = map(asset.path)
    if (asset.proxyPath) asset.proxyPath = map(asset.proxyPath)
    if (asset.voice?.rawPath) asset.voice.rawPath = map(asset.voice.rawPath)
  }
  for (const text of next.texts ?? []) text.path = map(text.path)
  for (const track of next.tracks) {
    for (const clip of track.clips) {
      const history = clip.voiceover
      if (history?.settings.customVoice) {
        history.settings.customVoice.referencePath = map(history.settings.customVoice.referencePath)
      }
      for (const version of history?.versions ?? []) {
        version.path = map(version.path)
        if (version.settings.customVoice) {
          version.settings.customVoice.referencePath = map(version.settings.customVoice.referencePath)
        }
      }
    }
  }
  for (const voice of next.voiceClones ?? []) voice.referencePath = map(voice.referencePath)
  return next
}

function customVoiceRecords(project: Project) {
  const records = [...(project.voiceClones ?? [])]
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.voiceover?.settings.customVoice) records.push(clip.voiceover.settings.customVoice)
      for (const version of clip.voiceover?.versions ?? []) {
        if (version.settings.customVoice) records.push(version.settings.customVoice)
      }
    }
  }
  return records
}

/** Copy custom references beside an ordinary .kadr save. Media dependencies
 * remain external, but a voice identity is always part of the project. */
export async function embedProjectVoiceClones(project: Project, projectPath: string): Promise<Project> {
  const next = clone(project)
  const records = customVoiceRecords(next)
  if (!records.length) return next
  const destination = join(
    dirname(projectPath),
    `${basename(projectPath, '.kadr')}.media`,
    'voices'
  )
  await fs.mkdir(destination, { recursive: true })
  const copied = new Map<string, string>()
  for (const voice of records) {
    const source = resolveStoredPath(voice.referencePath, projectPath)
    let target = copied.get(source)
    if (!target) {
      target = join(destination, `${safeName(voice.id, 'custom-voice')}.wav`)
      if (resolve(source) !== resolve(target)) await fs.copyFile(source, target)
      copied.set(source, target)
    }
    voice.referencePath = target
  }
  return next
}

export function projectForDisk(project: Project, projectPath: string): Project {
  return mapProjectPaths(project, (value) => insideProject(value, projectPath))
}

export async function readProjectFile(projectPath: string): Promise<Project> {
  const stored = JSON.parse(await fs.readFile(projectPath, 'utf8')) as Project
  const project = mapProjectPaths(stored, (value) => resolveStoredPath(value, projectPath))
  const fragmentIds = [...new Set(project.tracks.flatMap((track) => track.clips)
    .filter((clip) => clip.kind === 'remotion' && clip.fragmentId)
    .map((clip) => clip.fragmentId!))]
  if (fragmentIds.length) {
    await restoreProjectFragments(join(dirname(projectPath), 'fragments'), fragmentIds)
  }
  return project
}

async function uniqueDirectory(parentDir: string, name: string, reserveZip: boolean): Promise<string> {
  for (let index = 1; index < 10_000; index++) {
    const candidateName = index === 1 ? name : `${name} ${index}`
    const candidate = join(parentDir, candidateName)
    if (reserveZip) {
      try {
        await fs.access(join(parentDir, `${candidateName}.zip`))
        continue
      } catch { /* available */ }
    }
    try {
      await fs.mkdir(candidate)
      return candidate
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error
    }
  }
  throw new Error('Could not create a unique project folder')
}

async function zipDirectory(folderPath: string, zipPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(zipPath)
    const archive = new ZipArchive({ zlib: { level: 6 } })
    output.once('close', resolvePromise)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.directory(folderPath, basename(folderPath))
    void archive.finalize()
  })
}

export async function packageProject(
  parentDir: string,
  sourceProjectPath: string | null,
  project: Project,
  options: ProjectPackageOptions
): Promise<ProjectPackageResult> {
  const folderName = safeName(project.name, 'Project')
  const folderPath = await uniqueDirectory(parentDir, folderName, options.zip)
  const projectPath = join(folderPath, `${folderName}.kadr`)
  let zipPath: string | undefined

  try {
    let packaged = clone(project)
    if (options.includeDependencies) {
      const copied = new Map<string, string>()
      let fileIndex = 0
      const sourcePath = (value: string) => resolveStoredPath(value, sourceProjectPath ?? projectPath)
      const copy = async (value: string, group: 'media' | 'texts', required: boolean): Promise<string | null> => {
        const source = sourcePath(value)
        const key = resolve(source)
        const existing = copied.get(key)
        if (existing) return existing
        try {
          const stat = await fs.stat(source)
          if (!stat.isFile()) throw new Error('not a file')
        } catch (error) {
          if (!required) return null
          throw new Error(`Dependency is missing: ${source}`, { cause: error })
        }
        const relativePath = `${group}/${String(++fileIndex).padStart(3, '0')}-${safeName(basename(source), 'file')}`
        await fs.mkdir(join(folderPath, group), { recursive: true })
        await fs.copyFile(source, join(folderPath, relativePath))
        copied.set(key, relativePath)
        return relativePath
      }

      for (const asset of packaged.assets) {
        asset.path = (await copy(asset.path, 'media', true))!
        if (asset.proxyPath) {
          const proxy = await copy(asset.proxyPath, 'media', false)
          if (proxy) asset.proxyPath = proxy
          else delete asset.proxyPath
        }
        if (asset.voice?.rawPath) {
          const raw = await copy(asset.voice.rawPath, 'media', false)
          if (raw) asset.voice.rawPath = raw
          else delete asset.voice.rawPath
        }
      }
      for (const text of packaged.texts ?? []) {
        text.path = (await copy(text.path, 'texts', true))!
      }
      for (const track of packaged.tracks) {
        for (const clip of track.clips) {
          const versions = clip.voiceover?.versions ?? []
          for (const version of versions) {
            const path = await copy(version.path, 'media', false)
            if (path) version.path = path
          }
        }
      }

      const fragmentIds = [...new Set(packaged.tracks.flatMap((track) => track.clips)
        .filter((clip) => clip.kind === 'remotion' && clip.fragmentId)
        .map((clip) => clip.fragmentId!))]
      if (fragmentIds.length) {
        await copyProjectFragments(fragmentIds, join(folderPath, 'fragments'))
      }
    }

    // Voice identities are always portable, even when the user chooses not to
    // copy the much larger media dependencies.
    const copiedVoices = new Map<string, string>()
    for (const voice of customVoiceRecords(packaged)) {
      const source = resolveStoredPath(voice.referencePath, sourceProjectPath ?? projectPath)
      let relativePath = copiedVoices.get(resolve(source))
      if (!relativePath) {
        relativePath = `voices/${safeName(voice.id, 'custom-voice')}.wav`
        await fs.mkdir(join(folderPath, 'voices'), { recursive: true })
        await fs.copyFile(source, join(folderPath, relativePath))
        copiedVoices.set(resolve(source), relativePath)
      }
      voice.referencePath = relativePath
    }

    if (!options.includeDependencies) packaged = projectForDisk(packaged, projectPath)

    await fs.writeFile(projectPath, JSON.stringify(packaged, null, 1), 'utf8')
    if (options.zip) {
      zipPath = join(parentDir, `${basename(folderPath)}.zip`)
      await zipDirectory(folderPath, zipPath)
    }
    return { projectPath, folderPath, zipPath }
  } catch (error) {
    await fs.rm(folderPath, { recursive: true, force: true })
    if (zipPath) await fs.rm(zipPath, { force: true })
    throw error
  }
}
