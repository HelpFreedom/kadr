// Project-library effects: `<project>/kadr-lib/effects/*.glsl` (format in
// shared/effectFile.ts). Main lists and parses the files and watches the
// folder; the renderer compiles them. A saved project gets the folder when it
// is watched, so there is always one place to drop an effect into.
import { ipcMain, type WebContents } from 'electron'
import { promises as fsp, watch, type FSWatcher } from 'fs'
import { join } from 'path'
import { parseEffectFile, MAX_EFFECT_FILE, type EffectFile, type EffectFileError } from '@shared/effectFile'

export const effectsDir = (projectDir: string) => join(projectDir, 'kadr-lib', 'effects')

export async function listEffectFiles(projectDir: string): Promise<(EffectFile | EffectFileError)[]> {
  const dir = effectsDir(projectDir)
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  const out: (EffectFile | EffectFileError)[] = []
  for (const name of names.filter((n) => n.endsWith('.glsl')).sort()) {
    const path = join(dir, name)
    try {
      const st = await fsp.stat(path)
      if (!st.isFile()) continue
      if (st.size > MAX_EFFECT_FILE) {
        out.push({ id: `lib:${name}`, file: name, error: `the file is over ${MAX_EFFECT_FILE / 1024} KB` })
        continue
      }
      out.push(parseEffectFile(name, await fsp.readFile(path, 'utf8')))
    } catch (e) {
      out.push({ id: `lib:${name}`, file: name, error: String((e as Error).message ?? e) })
    }
  }
  return out
}

// one watched folder at a time: the open project's
let watcher: FSWatcher | null = null
let watchedDir: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null

async function watchEffects(projectDir: string | null, sender: WebContents): Promise<string | null> {
  const dir = projectDir ? effectsDir(projectDir) : null
  // a watch dies silently with its folder: a folder deleted and made again at
  // the same path needs a new one
  const alive = dir ? await fsp.stat(dir).then((s) => s.isDirectory(), () => false) : false
  if (dir === watchedDir && watcher && alive) return dir
  watcher?.close()
  watcher = null
  watchedDir = null
  if (!dir) return null
  await fsp.mkdir(dir, { recursive: true })
  // editors save through a rename and fire several events per save: one
  // debounced notice is enough, the renderer re-reads the whole folder
  watcher = watch(dir, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (!sender.isDestroyed()) sender.send('effects:changed')
    }, 150)
  })
  watcher.on('error', () => { watcher?.close(); watcher = null; watchedDir = null })
  watchedDir = dir
  return dir
}

export function registerEffectIpc() {
  ipcMain.handle('effects:list', (_e, projectDir: string) => listEffectFiles(String(projectDir)))
  ipcMain.handle('effects:watch', (e, projectDir: string | null) =>
    watchEffects(projectDir ? String(projectDir) : null, e.sender))
}
