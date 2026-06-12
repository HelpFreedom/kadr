// Vegas-style pan/crop editor: a zoomable stage where the clip's frame is
// dragged/scaled/rotated/masked directly, multiple shape masks with feathered
// borders, snapping to the frame and to other layers, and a zoomable
// mini-timeline with draggable keyframe diamonds.
import { useEffect, useRef, useState } from 'react'
import type { Anim, Clip, Keyframe, MaskShape, MaskShapeType } from '@shared/types'
import { useEditor, findClip, usePosePresets, type PosePreset } from '@/state/store'
import { evalAnim } from '@/engine/anim'
import { videoLayersAt } from '@/engine/player'
import { useT, type TKey } from '@/i18n'
import { CtxMenu } from './CtxMenu'

const KF_EPS = 0.02

interface ParamDef {
  key: string
  label: TKey
  step: number
  min?: number
  max?: number
  get(c: Clip): Anim
  patch(c: Clip, a: Anim): Partial<Clip>
}

const defAnim = (v: number): Anim => ({ value: v })
const maskOf = (c: Clip) =>
  c.mask ?? { left: defAnim(0), top: defAnim(0), right: defAnim(0), bottom: defAnim(0) }
const shapesOf = (c: Clip): MaskShape[] => c.maskShapes ?? (c.maskShape ? [c.maskShape] : [])
const patchShapes = (arr: MaskShape[]): Partial<Clip> => ({ maskShapes: arr, maskShape: undefined })

const TRANSFORM_PARAMS: ParamDef[] = [
  { key: 'x', label: 'animX', step: 1, get: (c) => c.transform.x, patch: (c, a) => ({ transform: { ...c.transform, x: a } }) },
  { key: 'y', label: 'animY', step: 1, get: (c) => c.transform.y, patch: (c, a) => ({ transform: { ...c.transform, y: a } }) },
  { key: 'scale', label: 'scale', step: 0.05, min: 0.01, max: 20, get: (c) => c.transform.scale, patch: (c, a) => ({ transform: { ...c.transform, scale: a } }) },
  { key: 'rotation', label: 'rotation', step: 1, get: (c) => c.transform.rotation, patch: (c, a) => ({ transform: { ...c.transform, rotation: a } }) },
  { key: 'opacity', label: 'opacity', step: 0.05, min: 0, max: 1, get: (c) => c.transform.opacity, patch: (c, a) => ({ transform: { ...c.transform, opacity: a } }) }
]

const TRANSFORM_3D_PARAMS: ParamDef[] = [
  { key: 'rotX', label: 'rot3dX', step: 1, get: (c) => c.transform.rotX ?? defAnim(0), patch: (c, a) => ({ transform: { ...c.transform, rotX: a } }) },
  { key: 'rotY', label: 'rot3dY', step: 1, get: (c) => c.transform.rotY ?? defAnim(0), patch: (c, a) => ({ transform: { ...c.transform, rotY: a } }) },
  { key: 'z', label: 'zDepth', step: 10, get: (c) => c.transform.z ?? defAnim(0), patch: (c, a) => ({ transform: { ...c.transform, z: a } }) }
]

const MASK_PARAMS: ParamDef[] = [
  { key: 'mL', label: 'maskLeft', step: 0.01, min: 0, max: 0.49, get: (c) => maskOf(c).left, patch: (c, a) => ({ mask: { ...maskOf(c), left: a } }) },
  { key: 'mT', label: 'maskTop', step: 0.01, min: 0, max: 0.49, get: (c) => maskOf(c).top, patch: (c, a) => ({ mask: { ...maskOf(c), top: a } }) },
  { key: 'mR', label: 'maskRight', step: 0.01, min: 0, max: 0.49, get: (c) => maskOf(c).right, patch: (c, a) => ({ mask: { ...maskOf(c), right: a } }) },
  { key: 'mB', label: 'maskBottom', step: 0.01, min: 0, max: 0.49, get: (c) => maskOf(c).bottom, patch: (c, a) => ({ mask: { ...maskOf(c), bottom: a } }) }
]

type ShapeField = 'cx' | 'cy' | 'w' | 'h' | 'featherIn' | 'featherOut'

function shapeParam(
  i: number, field: ShapeField, label: TKey, step: number, min: number, max: number
): ParamDef {
  return {
    key: `s${i}.${field}`, label, step, min, max,
    get: (c) => shapesOf(c)[i]?.[field] ?? defAnim(field === 'featherIn' || field === 'featherOut' ? 0 : 0.5),
    patch: (c, a) => patchShapes(shapesOf(c).map((s, j) => (j === i ? { ...s, [field]: a } : s)))
  }
}

const makeShapeParams = (i: number): ParamDef[] => [
  shapeParam(i, 'cx', 'shapeX', 0.01, -0.5, 1.5),
  shapeParam(i, 'cy', 'shapeY', 0.01, -0.5, 1.5),
  shapeParam(i, 'w', 'shapeW', 0.01, 0.01, 2),
  shapeParam(i, 'h', 'shapeH', 0.01, 0.01, 2),
  shapeParam(i, 'featherIn', 'featherIn', 0.005, 0, 0.5),
  shapeParam(i, 'featherOut', 'featherOut', 0.005, 0, 0.5)
]

function sortedKfs(a: Anim): Keyframe[] {
  return [...(a.keyframes ?? [])].sort((x, y) => x.time - y.time)
}

function upsertKf(a: Anim, time: number, value: number): Anim {
  const existing = a.keyframes?.find((k) => Math.abs(k.time - time) < KF_EPS)
  const kfs = sortedKfs(a).filter((k) => Math.abs(k.time - time) >= KF_EPS)
  kfs.push({ time, value, easing: existing?.easing ?? 'linear' })
  kfs.sort((x, y) => x.time - y.time)
  return { ...a, keyframes: kfs }
}

/**
 * Apply a new value. Once a parameter has keyframes, every edit is its own
 * state — a keyframe at the playhead (so a rotation at frame 1 and a move at
 * frame 120 stay independent). The link toggle only controls whether editing
 * a *static* parameter starts recording keyframes.
 */
function applyValue(anim: Anim, rel: number, value: number, linked: boolean): Anim {
  if (anim.keyframes?.length || linked) return upsertKf(anim, rel, value)
  return { ...anim, value }
}

function snap1(v: number, targets: number[], tol: number): number {
  let best = v
  let bd = tol
  for (const t of targets) {
    const d = Math.abs(t - v)
    if (d < bd) {
      bd = d
      best = t
    }
  }
  return best
}

function windowDrag(
  e: { clientX: number; clientY: number },
  move: (dx: number, dy: number, ev: PointerEvent) => void,
  done?: (moved: boolean) => void
) {
  const sx = e.clientX
  const sy = e.clientY
  let moved = false
  const onMove = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true
    move(ev.clientX - sx, ev.clientY - sy, ev)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    done?.(moved)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

type Tool = 'edges' | MaskShapeType
const DEFAULT_STAGE_ZOOM = 0.85

export function AnimEditor({ width }: { width: number }) {
  const t = useT()
  const found = useEditor((s) => (s.animClipId ? findClip(s.project, s.animClipId) : null))
  const playhead = useEditor((s) => s.playhead)
  const projW = useEditor((s) => s.project.width)
  const projH = useEditor((s) => s.project.height)
  const fps = useEditor((s) => s.project.fps)
  const asset = useEditor((s) => {
    const f = s.animClipId ? findClip(s.project, s.animClipId) : null
    return f?.clip.assetId ? s.project.assets.find((a) => a.id === f.clip.assetId) : undefined
  })
  const [mode, setMode] = useState<'transform' | 'mask'>('transform')
  const [tool, setTool] = useState<Tool>('edges')
  const [linked, setLinked] = useState(false)
  const [snapOn, setSnapOn] = useState(true)
  const [lockX, setLockX] = useState(false)
  const [lockY, setLockY] = useState(false)
  const [stageZoom, setStageZoom] = useState(DEFAULT_STAGE_ZOOM)
  const [selShape, setSelShape] = useState(0)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [presetMenu, setPresetMenu] = useState<{ x: number; y: number } | null>(null)
  const [presetName, setPresetName] = useState('')
  const posePresets = usePosePresets((s) => s.presets)
  const stageRef = useRef<HTMLDivElement>(null)
  const miniRef = useRef<HTMLDivElement>(null)
  const clipId = found?.clip.id
  const clipDur = found?.clip.duration ?? 1
  const [miniView, setMiniView] = useState({ t0: -clipDur * 0.04, t1: clipDur * 1.04 })

  useEffect(() => {
    if (clipId) {
      const d = useEditor.getState().animClipId
        ? findClip(useEditor.getState().project, useEditor.getState().animClipId!)?.clip.duration ?? 1
        : 1
      setMiniView({ t0: -d * 0.04, t1: d * 1.04 })
      setLinked(false)
      setSelShape(0)
      setStageZoom(DEFAULT_STAGE_ZOOM)
      setPresetMenu(null)
    }
  }, [clipId])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setStageZoom((z) => Math.min(3, Math.max(0.15, z * Math.exp(-e.deltaY * 0.0015))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [clipId])

  useEffect(() => {
    const el = miniRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setMiniView((v) => {
        const span = v.t1 - v.t0
        if (e.shiftKey) {
          const d = span * 0.0015 * e.deltaY
          return { t0: v.t0 + d, t1: v.t1 + d }
        }
        const r = el.getBoundingClientRect()
        const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
        const at = v.t0 + span * f
        const ns = Math.min(span * 8 + 0.0001, Math.max(0.05, span * Math.exp(e.deltaY * 0.0015)))
        return { t0: at - ns * f, t1: at + ns * (1 - f) }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [clipId])

  useEffect(() => {
    if (!ctxMenu) return
    const close = () => setCtxMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [ctxMenu])

  useEffect(() => {
    if (!presetMenu) return
    const close = () => setPresetMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [presetMenu])

  if (!found) {
    queueMicrotask(() => useEditor.getState().setAnimClip(null))
    return null
  }
  const clip = found.clip
  const is3D = !!clip.transform.rotX
  const transformDefs = is3D ? [...TRANSFORM_PARAMS, ...TRANSFORM_3D_PARAMS] : TRANSFORM_PARAMS
  let rel = Math.max(0, Math.min(clip.duration, playhead - clip.start))
  // land exactly on the clip edges so frame-0 keyframes are possible
  if (rel < KF_EPS) rel = 0
  else if (clip.duration - rel < KF_EPS) rel = clip.duration
  const inside = playhead >= clip.start - 1e-6 && playhead <= clip.start + clip.duration + 1e-6
  const shapes = shapesOf(clip)
  const selIdx = Math.min(selShape, Math.max(0, shapes.length - 1))
  const selShapeParams = shapes.length ? makeShapeParams(selIdx) : []
  const allShapeParams = shapes.flatMap((_, i) => makeShapeParams(i))

  // ----------------------------------------------------------- stage maths
  const stageW = Math.max(160, width - 22)
  const stageH = Math.round((stageW * projH) / projW)
  const k = (stageW / projW) * stageZoom

  const val = (p: ParamDef) => evalAnim(p.get(clip), rel)
  const cur = {
    x: val(TRANSFORM_PARAMS[0]),
    y: val(TRANSFORM_PARAMS[1]),
    scale: val(TRANSFORM_PARAMS[2]),
    rotation: val(TRANSFORM_PARAMS[3]),
    opacity: val(TRANSFORM_PARAMS[4]),
    mL: val(MASK_PARAMS[0]),
    mT: val(MASK_PARAMS[1]),
    mR: val(MASK_PARAMS[2]),
    mB: val(MASK_PARAMS[3])
  }

  const srcW = asset && asset.width ? asset.width : projW
  const srcH = asset && asset.height ? asset.height : projH
  const fit = Math.min(projW / srcW, projH / srcH)
  const layerW = Math.max(8, srcW * fit * cur.scale * k)
  const layerH = Math.max(8, srcH * fit * cur.scale * k)
  const cx = stageW / 2 + cur.x * k
  const cy = stageH / 2 + cur.y * k
  const frameW = projW * k
  const frameH = projH * k

  const write = (p: ParamDef, value: number) => {
    if (p.min !== undefined) value = Math.max(p.min, value)
    if (p.max !== undefined) value = Math.min(p.max, value)
    const st = useEditor.getState()
    const f = findClip(st.project, clip.id)
    if (!f) return
    st.updateClip(clip.id, p.patch(f.clip, applyValue(p.get(f.clip), rel, value, linked && inside)))
  }

  const push = (label: string) => useEditor.getState().pushHistory(label)
  const gestureLabel = () => (linked ? 'hKeyframe' : 'hEdit')

  /** pointer position → layer-local UV (0..1), honoring rotation */
  const toLayerUV = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect()
    const dx = clientX - r.left - cx
    const dy = clientY - r.top - cy
    const rad = (-cur.rotation * Math.PI) / 180
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
    return { u: 0.5 + lx / layerW, v: 0.5 + ly / layerH }
  }

  /** snap anchors from the frame corners/center and other layers in the scene */
  const buildMoveSnaps = () => {
    const st = useEditor.getState()
    const hw = (srcW * fit * cur.scale) / 2
    const hh = (srcH * fit * cur.scale) / 2
    const ax = [-projW / 2, 0, projW / 2]
    const ay = [-projH / 2, 0, projH / 2]
    for (const l of videoLayersAt(st.project, st.playhead)) {
      if (l.clip.id === clip.id) continue
      const lr = st.playhead - l.clip.start
      const lw = l.asset?.width || projW
      const lh = l.asset?.height || projH
      const lfit = Math.min(projW / lw, projH / lh)
      const ls = evalAnim(l.clip.transform.scale, lr)
      const lx = evalAnim(l.clip.transform.x, lr)
      const ly = evalAnim(l.clip.transform.y, lr)
      ax.push(lx - (lw * lfit * ls) / 2, lx, lx + (lw * lfit * ls) / 2)
      ay.push(ly - (lh * lfit * ls) / 2, ly, ly + (lh * lfit * ls) / 2)
    }
    const candX = ax.flatMap((a) => [a + hw, a, a - hw])
    const candY = ay.flatMap((a) => [a + hh, a, a - hh])
    return { candX, candY }
  }

  // gestures ---------------------------------------------------------------
  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    if (mode === 'mask' && tool !== 'edges') {
      startDrawShape(e)
      return
    }
    if (mode === 'mask') return
    push(gestureLabel())
    const x0 = cur.x
    const y0 = cur.y
    const { candX, candY } = buildMoveSnaps()
    const tol = snapOn ? 7 / k : 0
    windowDrag(e, (dx, dy) => {
      if (!lockX) write(TRANSFORM_PARAMS[0], snap1(x0 + dx / k, candX, tol))
      if (!lockY) write(TRANSFORM_PARAMS[1], snap1(y0 + dy / k, candY, tol))
    })
  }

  const startScale = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    push(gestureLabel())
    const r = stageRef.current!.getBoundingClientRect()
    const pcx = r.left + cx
    const pcy = r.top + cy
    const d0 = Math.max(4, Math.hypot(e.clientX - pcx, e.clientY - pcy))
    const s0 = cur.scale
    windowDrag(e, (_dx, _dy, ev) => {
      const d1 = Math.max(4, Math.hypot(ev.clientX - pcx, ev.clientY - pcy))
      let ns = s0 * (d1 / d0)
      if (snapOn && Math.abs(ns - 1) < 0.04) ns = 1 // sticky at natural size
      write(TRANSFORM_PARAMS[2], ns)
    })
  }

  // 3D orbit: horizontal drag turns around Y, vertical drag around X
  const startOrbit = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    push(gestureLabel())
    const rx0 = evalAnim(clip.transform.rotX ?? defAnim(0), rel)
    const ry0 = evalAnim(clip.transform.rotY ?? defAnim(0), rel)
    windowDrag(e, (dx, dy) => {
      let nry = ry0 + dx * 0.4
      let nrx = rx0 - dy * 0.4
      if (snapOn) {
        const my = Math.round(nry / 45) * 45
        if (Math.abs(nry - my) < 4) nry = my
        const mx = Math.round(nrx / 45) * 45
        if (Math.abs(nrx - mx) < 4) nrx = mx
      }
      write(TRANSFORM_3D_PARAMS[1], nry)
      write(TRANSFORM_3D_PARAMS[0], nrx)
    })
  }

  const startRotate = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    push(gestureLabel())
    const r = stageRef.current!.getBoundingClientRect()
    const pcx = r.left + cx
    const pcy = r.top + cy
    const a0 = (Math.atan2(e.clientY - pcy, e.clientX - pcx) * 180) / Math.PI
    const r0 = cur.rotation
    windowDrag(e, (_dx, _dy, ev) => {
      const a1 = (Math.atan2(ev.clientY - pcy, ev.clientX - pcx) * 180) / Math.PI
      let nr = r0 + (a1 - a0)
      if (ev.shiftKey) nr = Math.round(nr / 15) * 15
      // snap to the cardinal/diagonal angles: 0, ±45, ±90, ±135, 180…
      if (snapOn) {
        const m45 = Math.round(nr / 45) * 45
        if (Math.abs(nr - m45) < 4) nr = m45
      }
      write(TRANSFORM_PARAMS[3], nr)
    })
  }

  const startMaskEdge = (which: 0 | 1 | 2 | 3) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    push(gestureLabel())
    const p = MASK_PARAMS[which]
    const v0 = evalAnim(p.get(clip), rel)
    const rad = (-cur.rotation * Math.PI) / 180
    const tol = snapOn ? 7 / (which === 0 || which === 2 ? layerW : layerH) : 0
    windowDrag(e, (dx, dy) => {
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
      const d =
        which === 0 ? lx / layerW : which === 2 ? -lx / layerW : which === 1 ? ly / layerH : -ly / layerH
      write(p, snap1(v0 + d, [0, 0.25, 0.5], tol))
    })
  }

  // shape gestures ----------------------------------------------------------
  const startDrawShape = (e: React.PointerEvent) => {
    push('hEdit')
    const a = toLayerUV(e.clientX, e.clientY)
    const type = tool as MaskShapeType
    const st = useEditor.getState()
    const newShape: MaskShape = {
      type,
      cx: defAnim(a.u), cy: defAnim(a.v), w: defAnim(0.05), h: defAnim(0.05),
      featherIn: defAnim(0), featherOut: defAnim(0), invert: false
    }
    const f0 = findClip(st.project, clip.id)
    if (!f0) return
    const idx = shapesOf(f0.clip).length
    st.updateClip(clip.id, patchShapes([...shapesOf(f0.clip), newShape]))
    setSelShape(idx)
    windowDrag(e, (_dx, _dy, ev) => {
      const b = toLayerUV(ev.clientX, ev.clientY)
      const f = findClip(st.project, clip.id)
      if (!f) return
      const arr = shapesOf(f.clip).map((s, j) =>
        j === idx
          ? {
              ...s,
              cx: defAnim((a.u + b.u) / 2),
              cy: defAnim((a.v + b.v) / 2),
              w: defAnim(Math.max(0.02, Math.abs(b.u - a.u))),
              h: defAnim(Math.max(0.02, Math.abs(b.v - a.v)))
            }
          : s
      )
      st.updateClip(clip.id, patchShapes(arr))
    })
  }

  const startShapeMove = (i: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelShape(i)
    if (mode !== 'mask') return
    push(gestureLabel())
    const defs = makeShapeParams(i)
    const cx0 = evalAnim(defs[0].get(clip), rel)
    const cy0 = evalAnim(defs[1].get(clip), rel)
    const rad = (-cur.rotation * Math.PI) / 180
    windowDrag(e, (dx, dy) => {
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
      // snap the shape center to the layer center and edges
      if (!lockX) write(defs[0], snap1(cx0 + lx / layerW, [0, 0.5, 1], snapOn ? 7 / layerW : 0))
      if (!lockY) write(defs[1], snap1(cy0 + ly / layerH, [0, 0.5, 1], snapOn ? 7 / layerH : 0))
    })
  }

  const startShapeResize = (i: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    setSelShape(i)
    push(gestureLabel())
    const defs = makeShapeParams(i)
    const w0 = evalAnim(defs[2].get(clip), rel)
    const h0 = evalAnim(defs[3].get(clip), rel)
    const rad = (-cur.rotation * Math.PI) / 180
    windowDrag(e, (dx, dy) => {
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad)
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad)
      write(defs[2], snap1(w0 + (2 * lx) / layerW, [0.25, 0.5, 1], snapOn ? 7 / layerW : 0))
      write(defs[3], snap1(h0 + (2 * ly) / layerH, [0.25, 0.5, 1], snapOn ? 7 / layerH : 0))
    })
  }

  // pose presets: save the current mask/transform state under a name and
  // re-apply it anywhere — values land through the regular keyframe path
  const savePose = () => {
    const name = presetName.trim()
    if (!name) return
    if (mode === 'transform') {
      const values: Record<string, number> = {}
      for (const p of transformDefs) values[p.key] = evalAnim(p.get(clip), rel)
      usePosePresets.getState().savePreset({ name, kind: 'transform', values })
    } else {
      usePosePresets.getState().savePreset({
        name,
        kind: 'mask',
        edges: { left: cur.mL, top: cur.mT, right: cur.mR, bottom: cur.mB },
        shapes: shapes.map((s) => ({
          type: s.type,
          invert: s.invert,
          cx: evalAnim(s.cx, rel), cy: evalAnim(s.cy, rel),
          w: evalAnim(s.w, rel), h: evalAnim(s.h, rel),
          featherIn: evalAnim(s.featherIn, rel), featherOut: evalAnim(s.featherOut, rel)
        }))
      })
    }
    setPresetName('')
  }

  const applyPose = (preset: PosePreset) => {
    push('hPreset')
    const st = useEditor.getState()
    if (preset.kind === 'transform' && preset.values) {
      const v3 = ['rotX', 'rotY', 'z'].some((k) => Math.abs(preset.values![k] ?? 0) > 1e-6)
      if (v3 && !is3D) {
        const f = findClip(st.project, clip.id)
        if (f) st.updateClip(clip.id, {
          transform: { ...f.clip.transform, rotX: defAnim(0), rotY: defAnim(0), z: defAnim(0) }
        })
      }
      for (const p of [...TRANSFORM_PARAMS, ...TRANSFORM_3D_PARAMS]) {
        const v = preset.values[p.key]
        if (v === undefined) continue
        if ((p.key === 'rotX' || p.key === 'rotY' || p.key === 'z') && !(v3 || is3D)) continue
        write(p, v)
      }
      return
    }
    if (preset.kind !== 'mask') return
    if (preset.edges) {
      write(MASK_PARAMS[0], preset.edges.left)
      write(MASK_PARAMS[1], preset.edges.top)
      write(MASK_PARAMS[2], preset.edges.right)
      write(MASK_PARAMS[3], preset.edges.bottom)
    }
    const ps = preset.shapes ?? []
    const f = findClip(st.project, clip.id)
    if (!f) return
    if (ps.length && shapesOf(f.clip).length === ps.length) {
      // same shape count — write per-field so animated shapes get a pose keyframe
      ps.forEach((s, i) => {
        const defs = makeShapeParams(i)
        write(defs[0], s.cx)
        write(defs[1], s.cy)
        write(defs[2], s.w)
        write(defs[3], s.h)
        write(defs[4], s.featherIn)
        write(defs[5], s.featherOut)
      })
      const f2 = findClip(useEditor.getState().project, clip.id)
      if (f2) useEditor.getState().updateClip(clip.id, patchShapes(
        shapesOf(f2.clip).map((s, i) => ({ ...s, type: ps[i].type, invert: ps[i].invert }))
      ))
    } else {
      // different layout — replace with the preset's shapes as static values
      useEditor.getState().updateClip(clip.id, patchShapes(ps.map((s) => ({
        type: s.type,
        invert: s.invert,
        cx: defAnim(s.cx), cy: defAnim(s.cy), w: defAnim(s.w), h: defAnim(s.h),
        featherIn: defAnim(s.featherIn), featherOut: defAnim(s.featherOut)
      }))))
    }
  }

  // link toggle: enabling snapshots the current state as the first keyframes
  const toggleLink = () => {
    const next = !linked
    setLinked(next)
    if (!next || !inside) return
    push('hKeyframe')
    const st = useEditor.getState()
    const f = findClip(st.project, clip.id)
    if (!f) return
    let c = { ...f.clip }
    let patch: Partial<Clip> = {}
    for (const p of [...transformDefs, ...MASK_PARAMS, ...allShapeParams]) {
      const a = p.get(c)
      if (a.keyframes?.length) continue
      const na: Anim = {
        ...a,
        keyframes: [{ time: rel, value: evalAnim(a, rel), easing: 'linear' }]
      }
      patch = { ...patch, ...p.patch(c, na) }
      c = { ...c, ...patch }
    }
    if (Object.keys(patch).length) st.updateClip(clip.id, patch)
  }

  // 3D transform toggle: adds rotX/rotY/Z params (perspective in the compositor)
  const toggle3D = () => {
    push('hEdit')
    const st = useEditor.getState()
    const f = findClip(st.project, clip.id)
    if (!f) return
    const tr = f.clip.transform
    st.updateClip(clip.id, {
      transform: is3D
        ? { ...tr, rotX: undefined, rotY: undefined, z: undefined }
        : { ...tr, rotX: defAnim(0), rotY: defAnim(0), z: defAnim(0) }
    })
  }

  // smooth (parabolic) interpolation per mode
  const modeDefs = mode === 'transform' ? transformDefs : [...MASK_PARAMS, ...allShapeParams]
  const smoothOn = modeDefs.some((p) => p.get(clip).smooth)
  const toggleSmooth = () => {
    push('hEdit')
    const st = useEditor.getState()
    const f = findClip(st.project, clip.id)
    if (!f) return
    let c = { ...f.clip }
    let patch: Partial<Clip> = {}
    for (const p of modeDefs) {
      patch = { ...patch, ...p.patch(c, { ...p.get(c), smooth: !smoothOn }) }
      c = { ...c, ...patch }
    }
    st.updateClip(clip.id, patch)
  }

  // context menu actions ----------------------------------------------------
  // restore defaults without losing animation: static params reset directly,
  // keyframed ones get a default-value keyframe at the playhead
  const restoreView = () => {
    push('hEdit')
    const st = useEditor.getState()
    const f = findClip(st.project, clip.id)
    if (!f) return
    const reset = (a: Anim, def: number): Anim =>
      a.keyframes?.length ? upsertKf(a, rel, def) : { ...a, value: def }
    if (mode === 'transform') {
      const tr = f.clip.transform
      st.updateClip(clip.id, {
        transform: {
          ...tr,
          x: reset(tr.x, 0), y: reset(tr.y, 0), scale: reset(tr.scale, 1), rotation: reset(tr.rotation, 0),
          // 3D space resets too when enabled
          rotX: tr.rotX ? reset(tr.rotX, 0) : tr.rotX,
          rotY: tr.rotY ? reset(tr.rotY, 0) : tr.rotY,
          z: tr.z ? reset(tr.z, 0) : tr.z
        }
      })
    } else {
      const m = maskOf(f.clip)
      const hasKfs = (s: MaskShape) =>
        [s.cx, s.cy, s.w, s.h, s.featherIn, s.featherOut].some((a) => a.keyframes?.length)
      st.updateClip(clip.id, {
        mask: {
          left: reset(m.left, 0), top: reset(m.top, 0),
          right: reset(m.right, 0), bottom: reset(m.bottom, 0)
        },
        maskShapes: shapesOf(f.clip).filter(hasKfs),
        maskShape: undefined
      })
    }
    setCtxMenu(null)
  }
  const restoreField = () => {
    setStageZoom(DEFAULT_STAGE_ZOOM)
    setCtxMenu(null)
  }

  // mini-timeline ----------------------------------------------------------
  const kfTimes = (defs: ParamDef[]) => {
    const times: number[] = []
    for (const p of defs) {
      for (const kf of p.get(clip).keyframes ?? []) {
        if (!times.some((x) => Math.abs(x - kf.time) < KF_EPS)) times.push(kf.time)
      }
    }
    return times.sort((a, b) => a - b)
  }
  const maskDefs = [...MASK_PARAMS, ...allShapeParams]
  const rowT = kfTimes(transformDefs)
  const rowM = kfTimes(maskDefs)

  const removeKfsAt = (defs: ParamDef[], time: number) => {
    push('hKeyframe')
    const st = useEditor.getState()
    const f = findClip(st.project, clip.id)
    if (!f) return
    let c = { ...f.clip }
    let patch: Partial<Clip> = {}
    for (const p of defs) {
      const a = p.get(c)
      if (!a.keyframes?.length) continue
      const left = a.keyframes.filter((kf) => Math.abs(kf.time - time) >= KF_EPS)
      const na = left.length
        ? { ...a, keyframes: left }
        : { ...a, value: evalAnim(a, time), keyframes: undefined }
      patch = { ...patch, ...p.patch(c, na) }
      c = { ...c, ...patch }
    }
    st.updateClip(clip.id, patch)
  }

  const retimeKfs = (defs: ParamDef[], from: number, to: number) => {
    const st = useEditor.getState()
    const f = findClip(st.project, clip.id)
    if (!f) return
    let c = { ...f.clip }
    let patch: Partial<Clip> = {}
    for (const p of defs) {
      const a = p.get(c)
      if (!a.keyframes?.some((kf) => Math.abs(kf.time - from) < KF_EPS)) continue
      const kfs = a.keyframes!
        .map((kf) => (Math.abs(kf.time - from) < KF_EPS ? { ...kf, time: to } : kf))
        .sort((x, y) => x.time - y.time)
      patch = { ...patch, ...p.patch(c, { ...a, keyframes: kfs }) }
      c = { ...c, ...patch }
    }
    st.updateClip(clip.id, patch)
  }

  const jumpKf = (dir: -1 | 1) => {
    const times = mode === 'transform' ? rowT : rowM
    const target =
      dir > 0
        ? times.find((x) => x > rel + KF_EPS)
        : [...times].reverse().find((x) => x < rel - KF_EPS)
    if (target !== undefined) useEditor.getState().setPlayhead(clip.start + target)
  }

  const miniSpan = Math.max(0.001, miniView.t1 - miniView.t0)
  const miniPos = (tt: number) => ((tt - miniView.t0) / miniSpan) * 100
  const timeAtMini = (clientX: number, lane: HTMLElement) => {
    const r = lane.getBoundingClientRect()
    return miniView.t0 + ((clientX - r.left) / r.width) * miniSpan
  }

  const scrubMini = (e: React.PointerEvent<HTMLDivElement>) => {
    const lane = e.currentTarget
    useEditor.getState().setPlayhead(clip.start + timeAtMini(e.clientX, lane))
    windowDrag(e, (_dx, _dy, ev) => {
      useEditor.getState().setPlayhead(clip.start + timeAtMini(ev.clientX, lane))
    })
  }

  const startKfDrag = (defs: ParamDef[], tt: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const lane = (e.currentTarget as HTMLElement).closest('.mini-lane') as HTMLElement
    let cur0 = tt
    let pushed = false
    useEditor.getState().setKfMarker(clip.start + tt)
    windowDrag(
      e,
      (_dx, _dy, ev) => {
        if (!pushed) {
          push('hKeyframe')
          pushed = true
        }
        let nt = timeAtMini(ev.clientX, lane)
        const snapPx = (6 / lane.getBoundingClientRect().width) * miniSpan
        for (const s of [rel, 0, clip.duration]) {
          if (Math.abs(nt - s) < snapPx) nt = s
        }
        if (Math.abs(nt - cur0) > 1e-6) {
          retimeKfs(defs, cur0, nt)
          cur0 = nt
        }
        // mirror the dragged keyframe on the main timeline
        useEditor.getState().setKfMarker(clip.start + cur0)
      },
      (moved) => {
        useEditor.getState().setKfMarker(null)
        if (!moved) useEditor.getState().setPlayhead(clip.start + tt)
      }
    )
  }

  const shapeTools: { id: Tool; icon: string; title: TKey }[] = [
    { id: 'edges', icon: '⊞', title: 'toolEdges' },
    { id: 'rect', icon: '▭', title: 'toolRect' },
    { id: 'ellipse', icon: '◯', title: 'toolEllipse' },
    { id: 'triangle', icon: '△', title: 'toolTriangle' }
  ]

  const params = mode === 'transform' ? transformDefs : [...MASK_PARAMS, ...selShapeParams]
  const sel = shapes[selIdx]
  const selFi = sel ? evalAnim(sel.featherIn, rel) : 0
  const selFo = sel ? evalAnim(sel.featherOut, rel) : 0

  return (
    <div className="anim-editor">
      <div className="anim-toolbar">
        <button className={mode === 'transform' ? 'active' : ''} onClick={() => setMode('transform')}>
          {t('modeTransform')}
        </button>
        <button className={mode === 'mask' ? 'active' : ''} onClick={() => setMode('mask')}>
          {t('modeMask')}
        </button>
        <button
          className={presetMenu ? 'active' : ''}
          title={t('presetsHint')}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setPresetMenu(presetMenu ? null : { x: r.left, y: r.bottom + 4 })
          }}
        >
          ⭐ {t('presets')}
        </button>
        <span className="flex1" />
        <button className={`link-toggle ${linked ? 'on' : ''}`} title={t('linkHint')} onClick={toggleLink}>
          {linked ? '🔗' : '⛓'} {t('linkToTimeline')}
        </button>
      </div>

      <div className="anim-toolbar">
        <label className="anim-check">
          <input type="checkbox" checked={smoothOn} onChange={toggleSmooth} />
          {t('smoothMotion')}
        </label>
        <span className="flex1" />
        {mode === 'transform' && (
          <button className={is3D ? 'active' : ''} title={t('toggle3D')} onClick={toggle3D}>
            3D
          </button>
        )}
        <button
          className={snapOn ? 'active' : ''}
          title={t('snapToggle')}
          onClick={() => setSnapOn(!snapOn)}
        >
          🧲
        </button>
        <button
          className={lockX ? 'active locked' : ''}
          title={t('lockX')}
          onClick={() => setLockX(!lockX)}
        >
          {lockX ? '🔒X' : 'X'}
        </button>
        <button
          className={lockY ? 'active locked' : ''}
          title={t('lockY')}
          onClick={() => setLockY(!lockY)}
        >
          {lockY ? '🔒Y' : 'Y'}
        </button>
      </div>

      {mode === 'mask' && (
        <div className="anim-toolbar shape-tools">
          {shapeTools.map((s) => (
            <button
              key={s.id}
              className={tool === s.id ? 'active' : ''}
              title={t(s.title)}
              onClick={() => setTool(s.id)}
            >
              {s.icon}
            </button>
          ))}
          {shapes.length > 1 && (
            <span className="dim shape-counter">
              {selIdx + 1}/{shapes.length}
            </span>
          )}
          {sel && (
            <>
              <label className="anim-check" title={t('invertHint')}>
                <input
                  type="checkbox"
                  checked={sel.invert}
                  onChange={(e) => {
                    push('hEdit')
                    useEditor.getState().updateClip(clip.id, patchShapes(
                      shapes.map((s, j) => (j === selIdx ? { ...s, invert: e.target.checked } : s))
                    ))
                  }}
                />
                {t('invertMask')}
              </label>
              <button
                title={t('deleteShape')}
                onClick={() => {
                  push('hEdit')
                  useEditor.getState().updateClip(clip.id, patchShapes(
                    shapes.filter((_, j) => j !== selIdx)
                  ))
                  setSelShape(0)
                }}
              >
                🗑
              </button>
            </>
          )}
        </div>
      )}

      {mode === 'mask' && sel && (
        <div className="feather-row">
          <label>
            {t('featherIn')}
            <input
              type="range" min={0} max={0.4} step={0.005}
              value={selFi}
              onPointerDown={() => push(gestureLabel())}
              onChange={(e) => write(selShapeParams[4], Number(e.target.value))}
            />
          </label>
          <label>
            {t('featherOut')}
            <input
              type="range" min={0} max={0.4} step={0.005}
              value={selFo}
              onPointerDown={() => push(gestureLabel())}
              onChange={(e) => write(selShapeParams[5], Number(e.target.value))}
            />
          </label>
        </div>
      )}

      <div
        className="anim-stage"
        ref={stageRef}
        style={{ width: stageW, height: stageH }}
        onContextMenu={(e) => {
          e.preventDefault()
          setCtxMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <div
          className="stage-frame"
          style={{
            left: (stageW - frameW) / 2,
            top: (stageH - frameH) / 2,
            width: frameW,
            height: frameH
          }}
        />
        <div
          className={`anim-layer ${mode}`}
          style={{
            width: layerW,
            height: layerH,
            left: cx - layerW / 2,
            top: cy - layerH / 2,
            transform: is3D
              ? `perspective(900px) rotateX(${-evalAnim(clip.transform.rotX ?? defAnim(0), rel)}deg) ` +
                `rotateY(${evalAnim(clip.transform.rotY ?? defAnim(0), rel)}deg) rotate(${cur.rotation}deg)`
              : `rotate(${cur.rotation}deg)`,
            opacity: Math.max(0.25, cur.opacity)
          }}
          onPointerDown={startMove}
        >
          {asset?.thumbnail ? (
            <img src={asset.thumbnail} alt="" draggable={false} />
          ) : (
            <div className="anim-layer-fill">{clip.kind === 'text' ? 'T' : '◼'}</div>
          )}
          <div className="mask-shade" style={{ left: 0, top: 0, bottom: 0, width: `${cur.mL * 100}%` }} />
          <div className="mask-shade" style={{ right: 0, top: 0, bottom: 0, width: `${cur.mR * 100}%` }} />
          <div className="mask-shade" style={{ left: 0, top: 0, right: 0, height: `${cur.mT * 100}%` }} />
          <div className="mask-shade" style={{ left: 0, bottom: 0, right: 0, height: `${cur.mB * 100}%` }} />

          {shapes.map((s, i) => {
            const scx = evalAnim(s.cx, rel)
            const scy = evalAnim(s.cy, rel)
            const sw = evalAnim(s.w, rel)
            const sh = evalAnim(s.h, rel)
            return (
              <div
                key={i}
                className={`mask-shape ${s.type} ${s.invert ? 'inverted' : ''} ${i === selIdx && mode === 'mask' ? 'selected' : ''}`}
                style={{
                  left: `${(scx - sw / 2) * 100}%`,
                  top: `${(scy - sh / 2) * 100}%`,
                  width: `${sw * 100}%`,
                  height: `${sh * 100}%`
                }}
                onPointerDown={startShapeMove(i)}
              >
                {mode === 'mask' && i === selIdx && (
                  <div className="shape-resize" onPointerDown={startShapeResize(i)} />
                )}
              </div>
            )
          })}

          {mode === 'transform' && (
            <>
              {[
                { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }
              ].map((c2, i) => (
                <div
                  key={i}
                  className="scale-handle"
                  style={{ left: `${c2.x * 100}%`, top: `${c2.y * 100}%` }}
                  onPointerDown={startScale}
                />
              ))}
              <div className="rotate-handle" onPointerDown={startRotate} title={t('rotation')} />
              {is3D && (
                <div className="orbit-handle" onPointerDown={startOrbit} title={t('orbitHint')} />
              )}
            </>
          )}
          {mode === 'mask' && tool === 'edges' && (
            <>
              <div className="mask-handle h-left" style={{ left: `${cur.mL * 100}%` }} onPointerDown={startMaskEdge(0)} />
              <div className="mask-handle h-right" style={{ right: `${cur.mR * 100}%` }} onPointerDown={startMaskEdge(2)} />
              <div className="mask-handle h-top" style={{ top: `${cur.mT * 100}%` }} onPointerDown={startMaskEdge(1)} />
              <div className="mask-handle h-bottom" style={{ bottom: `${cur.mB * 100}%` }} onPointerDown={startMaskEdge(3)} />
            </>
          )}
        </div>
        <div className="stage-cross" />
        <div className="stage-zoom dim">
          {Math.round(stageZoom * 100)}%
          <button onClick={() => setStageZoom(DEFAULT_STAGE_ZOOM)} title="reset">⟲</button>
        </div>
      </div>

      {ctxMenu && (
        <CtxMenu x={ctxMenu.x} y={ctxMenu.y}>
          <button onClick={restoreView}>{t('ctxRestoreView')}</button>
          <button onClick={restoreField}>{t('ctxRestoreField')}</button>
        </CtxMenu>
      )}

      {presetMenu && (
        <CtxMenu x={presetMenu.x} y={presetMenu.y} className="preset-menu">
          <div className="ctx-title dim">
            {t('presets')} — {mode === 'transform' ? t('modeTransform') : t('modeMask')}
          </div>
          {posePresets.filter((p) => p.kind === mode).length === 0 && (
            <div className="ctx-empty dim">{t('noPresets')}</div>
          )}
          {posePresets
            .filter((p) => p.kind === mode)
            .map((p) => (
              <div className="preset-item" key={p.id}>
                <button
                  onClick={() => {
                    applyPose(p)
                    setPresetMenu(null)
                  }}
                >
                  {p.name}
                </button>
                <button
                  className="preset-del"
                  title={t('deletePreset')}
                  onClick={() => usePosePresets.getState().deletePreset(p.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          <div className="preset-save-row">
            <input
              value={presetName}
              placeholder={t('presetName')}
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') savePose()
              }}
            />
            <button disabled={!presetName.trim()} onClick={savePose}>
              {t('presetSave')}
            </button>
          </div>
        </CtxMenu>
      )}

      <div className="anim-values">
        {params.map((p) => (
          <label key={p.key} title={t(p.label)}>
            <span>{t(p.label)}</span>
            <input
              type="number"
              step={p.step}
              value={Number(evalAnim(p.get(clip), rel).toFixed(3))}
              onFocus={() => push('hEdit')}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (!Number.isNaN(v)) write(p, v)
              }}
            />
          </label>
        ))}
      </div>

      <div className="mini-tl" ref={miniRef}>
        <div className="mini-head">
          <span className="dim">
            {clip.duration.toFixed(2)}s · t={rel.toFixed(2)}s · {t('frameLbl')} {Math.floor(rel * fps)}
            {!inside && <span className="anim-warn"> · {t('outsideClip')}</span>}
          </span>
          <span className="flex1" />
          <button
            title={t('toClipStart')}
            onClick={() => useEditor.getState().setPlayhead(clip.start)}
          >
            |◀
          </button>
          <button title={t('kfPrev')} onClick={() => jumpKf(-1)}>◀</button>
          <button
            title={t('kfDelete')}
            disabled={!(mode === 'transform' ? rowT : rowM).some((x) => Math.abs(x - rel) < KF_EPS)}
            onClick={() => removeKfsAt(mode === 'transform' ? transformDefs : maskDefs, rel)}
          >
            ◆✕
          </button>
          <button title={t('kfNext')} onClick={() => jumpKf(1)}>▶</button>
          <button
            title={t('toClipEnd')}
            onClick={() => useEditor.getState().setPlayhead(clip.start + clip.duration)}
          >
            ▶|
          </button>
        </div>
        {[
          { label: t('modeTransform'), times: rowT, defs: transformDefs },
          { label: t('modeMask'), times: rowM, defs: maskDefs }
        ].map((row) => (
          <div className="mini-row" key={row.label}>
            <span className="mini-label">{row.label}</span>
            <div className="mini-lane" onPointerDown={scrubMini}>
              <div
                className="mini-band"
                style={{
                  left: `${Math.max(0, miniPos(0))}%`,
                  width: `${Math.max(0, Math.min(100, miniPos(clip.duration)) - Math.max(0, miniPos(0)))}%`
                }}
              />
              {row.times
                .filter((tt) => miniPos(tt) >= -1 && miniPos(tt) <= 101)
                .map((tt) => (
                  <div
                    key={tt}
                    className={`mini-kf ${Math.abs(tt - rel) < KF_EPS ? 'on' : ''}`}
                    style={{ left: `${miniPos(tt)}%` }}
                    title={`${tt.toFixed(2)}s — ${t('kfDragHint')}`}
                    onPointerDown={startKfDrag(row.defs, tt)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      removeKfsAt(row.defs, tt)
                    }}
                  />
                ))}
              {miniPos(rel) >= 0 && miniPos(rel) <= 100 && (
                <div className="mini-ph" style={{ left: `${miniPos(rel)}%` }} />
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="anim-hint dim">{t('vegasHint2')}</div>
    </div>
  )
}
