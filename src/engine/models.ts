// 3D models of the project, renderer side: the list shown in the bin
// (<project>/kadr-lib/models, written by electron/models.ts), importing files
// into it, and a ready fragment built on Kadr's 3D kit around one of them.
import { create } from 'zustand'
import type { ModelInfo } from '@shared/types'
import { dirOf } from '@shared/paths'
import { useEditor } from '@/state/store'
import { createFragment } from './fragments'
import { logError, logInfo } from './log'

export const MODEL_EXTS = ['stl', '3mf', 'obj', 'glb', 'gltf', 'step', 'stp']
export const isModelPath = (p: string) => MODEL_EXTS.includes(p.split('.').pop()?.toLowerCase() ?? '')

export const useModelsUi = create<{ models: (ModelInfo & { dir: string })[]; busy: number; forDir: string | null }>(() => ({
  models: [], busy: 0, forDir: null
}))

const projectDir = () => {
  const p = useEditor.getState().projectPath
  return p ? dirOf(p) : null
}

/** Re-read the project's models (after an import, on open). */
export async function refreshModels(): Promise<void> {
  const dir = projectDir()
  if (!dir) { useModelsUi.setState({ models: [], forDir: null }); return }
  const models = await window.kadr.modelList(dir).catch(() => [])
  useModelsUi.setState({ models, forDir: dir })
}

/** Keep the list in step with the open project. */
export function wireModels() {
  let last: string | null = null
  useEditor.subscribe((s) => {
    if (s.projectPath === last) return
    last = s.projectPath
    void refreshModels()
  })
}

/**
 * Import 3D files into the project's kadr-lib/models. Needs a saved project:
 * models live next to it and fragments import them from there.
 */
export async function importModels(paths: string[], opts: { budget?: number; name?: string } = {}): Promise<ModelInfo[]> {
  const dir = projectDir()
  if (!dir) throw new Error('3D-модели хранятся в папке проекта (kadr-lib/models) — сначала сохраните проект')
  const out: ModelInfo[] = []
  useModelsUi.setState((s) => ({ busy: s.busy + paths.length }))
  try {
    for (const p of paths) {
      try {
        const info = await window.kadr.modelImport(p, dir, { budget: opts.budget, name: paths.length === 1 ? opts.name : undefined })
        out.push(info)
        logInfo('3D', `${info.name}: ${info.sizeMm.map((x) => Math.round(x)).join(' × ')} мм, ${info.parts.length} дет., ${info.trianglesIn} → ${info.trianglesOut} треуг.`)
      } catch (e) {
        logError('3D', `${p}: ${String((e as Error)?.message ?? e)}`)
        if (paths.length === 1) throw e
      } finally {
        useModelsUi.setState((s) => ({ busy: s.busy - 1 }))
      }
    }
  } finally {
    await refreshModels()
  }
  return out
}

/** The TSX of a turntable around a model: a print-layer reveal, then a slow orbit — on Kadr's kit. */
export function modelFragmentTsx(name: string): string {
  return `import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { Scene3D, Studio, ShadowFloor, Camera, cameraPath, useModel, Part, Layer } from '@kadr/three'
import { defineInspect } from '@kadr/runtime'
import modelUrl from '@lib/models/${name}.glb'
import meta from './meta.json'

// «${name}» — a turntable from Kadr's 3D kit ('@kadr/three'). Everything is a
// function of t (composition seconds). The model comes from the project's
// kadr-lib/models (1 unit = 10 cm; it stands on y = 0, centred).
const DUR = meta.durationInFrames / meta.fps
const REVEAL = Math.min(2, DUR * 0.4) // the print layer sweeps up over this long

const Film: React.FC = () => {
  const { fps, width, height } = useVideoConfig()
  const t = useCurrentFrame() / fps
  const model = useModel(modelUrl)
  if (!model) return null
  const h = model.size[1]
  // far enough for the whole model in a 30° field of view, with a margin
  const r = (Math.max(model.size[0], model.size[1], model.size[2]) / 2) / Math.tan((15 * Math.PI) / 180) * 1.3
  const cam = camera(h, r)(t)
  const y = -0.01 + (h + 0.02) * Math.min(1, t / REVEAL)
  return (
    <Scene3D width={width} height={height} background="#0b0b10">
      <Studio shadowSize={Math.max(1.5, r)} />
      <Camera cam={cam} aspect={width / height} />
      <ShadowFloor />
      {model.list.map((p) => (
        <Part key={p.name} part={p} look={{ color: '#9c7ad8' }} layer={t < REVEAL ? { y, keep: 'below' } : undefined} />
      ))}
      {t < REVEAL && <Layer y={y} radius={Math.max(model.size[0], model.size[2]) * 0.75} />}
    </Scene3D>
  )
}

// one camera for the whole shot: a slow half-orbit, a little lower at the end
const camera = (h: number, r: number) => cameraPath([
  { t: 0, target: [0, h * 0.5, 0], az: -35, el: 18, r, fov: 30 },
  { t: DUR, target: [0, h * 0.5, 0], az: 35, el: 10, r: r * 0.92, fov: 30 }
])

export const fragment = { component: Film, meta, inspect: defineInspect({ events: [{ t: REVEAL, kind: 'big', label: 'модель готова' }] }) }
`
}

/** A new fragment on the timeline showing the model (at the playhead, 6 s by default). */
export async function insertModelFragment(name: string, opts: { start?: number; duration?: number } = {}) {
  const st = useEditor.getState()
  const start = opts.start ?? st.playhead
  const f = await createFragment({ name: `3d-${name}`, start, end: start + (opts.duration ?? 6), transparent: false })
  await window.kadr.writeTextFile(f.entry, modelFragmentTsx(name))
  return f
}

/**
 * «Для фрагмента»: a copy of a video asset a fragment's <Video> can use —
 * upright, SDR, keyframe every 30 frames — in kadr-lib/media. The import line
 * goes to the clipboard and the session log.
 */
export async function prepareForFragment(assetId: string, opts: { maxSide?: number } = {}) {
  const st = useEditor.getState()
  const a = st.project.assets.find((x) => x.id === assetId)
  if (!a) throw new Error('нет такого файла в корзине')
  const dir = projectDir()
  if (!dir) {
    logError('для фрагмента', 'видео для фрагментов хранится в папке проекта (kadr-lib/media) — сначала сохраните проект')
    return null
  }
  try {
    const r = await window.kadr.fragmentMedia(a.path, dir, { maxSide: opts.maxSide ?? Math.max(st.project.width, st.project.height) })
    const line = `import clip from '${r.import}'`
    try { await navigator.clipboard.writeText(line) } catch { /* no clipboard: the log has it */ }
    logInfo('для фрагмента', `${a.name} → ${r.import}${r.hdr ? ` (HDR ${r.hdr.toUpperCase()} → SDR)` : ''}${r.cached ? ', уже было' : ''} — строка импорта скопирована: ${line}`)
    return r
  } catch (e) {
    logError('для фрагмента', `${a.name}: ${String((e as Error)?.message ?? e)}`)
    throw e
  }
}
