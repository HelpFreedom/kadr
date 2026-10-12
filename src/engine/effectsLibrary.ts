// The open project's own effects (kadr-lib/effects/*.glsl, format in
// shared/effectFile.ts) kept in the effect registry: re-read when the project
// changes and whenever main reports a change in the folder, so an effect
// written by hand or by an agent is in the Inspector a moment later.
import { useEditor } from '@/state/store'
import { setLibraryEffects, type EffectDef } from '@/gl/effects'
import { dirOf } from '@shared/paths'
import { logWarn } from './log'

export async function refreshEffectsLibrary(): Promise<void> {
  const path = useEditor.getState().projectPath
  if (!path) { setLibraryEffects([], [], null); return }
  const projectDir = dirOf(path)
  const dir = await window.kadr.effectsWatch(projectDir).catch(() => null)
  const files = await window.kadr.effectsList(projectDir).catch(() => [])
  const defs: EffectDef[] = []
  const issues: { id: string; file: string; error: string }[] = []
  for (const f of files) {
    if ('error' in f) {
      issues.push(f)
      logWarn('эффекты', `kadr-lib/effects/${f.file}: ${f.error}`)
      continue
    }
    defs.push({ id: f.id, group: f.group, name: f.name, params: f.params, glsl: f.glsl,
      timeDependent: f.timeDependent, source: 'library', file: f.file })
  }
  setLibraryEffects(defs, issues, dir)
}

export function wireEffectsLibrary() {
  let last: string | null | undefined
  useEditor.subscribe((s) => {
    if (s.projectPath === last) return
    last = s.projectPath
    void refreshEffectsLibrary()
  })
  window.kadr.onEffectsChanged(() => void refreshEffectsLibrary())
}
