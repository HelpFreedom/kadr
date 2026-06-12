// Vegas-style Track Motion: an animated 3D transform for a whole video track.
// Keyframe times are absolute project seconds; the same auto-keyframe and
// link-to-timeline semantics as the clip editor.
import { useEffect, useRef, useState } from 'react'
import type { Anim, Transform3D } from '@shared/types'
import { useEditor, projectDuration } from '@/state/store'
import { KF_EPS, applyValue, evalAnim, resetValue, snap1, windowDrag } from './animUtils'
import { useT, type TKey } from '@/i18n'

const defAnim = (v: number): Anim => ({ value: v })

export const defaultMotion = (): Transform3D => ({
  x: defAnim(0), y: defAnim(0), scale: defAnim(1), rotation: defAnim(0),
  rotX: defAnim(0), rotY: defAnim(0), z: defAnim(0)
})

interface MDef {
  key: keyof Transform3D
  label: TKey
  step: number
  def: number
}

const M_PARAMS: MDef[] = [
  { key: 'x', label: 'animX', step: 1, def: 0 },
  { key: 'y', label: 'animY', step: 1, def: 0 },
  { key: 'scale', label: 'scale', step: 0.05, def: 1 },
  { key: 'rotation', label: 'rotation', step: 1, def: 0 },
  { key: 'rotX', label: 'rot3dX', step: 1, def: 0 },
  { key: 'rotY', label: 'rot3dY', step: 1, def: 0 },
  { key: 'z', label: 'zDepth', step: 10, def: 0 }
]

export function TrackMotionEditor({ width }: { width: number }) {
  const t = useT()
  const track = useEditor((s) =>
    s.motionTrackId ? s.project.tracks.find((tr) => tr.id === s.motionTrackId) : undefined
  )
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.project.fps)
  const projW = useEditor((s) => s.project.width)
  const projH = useEditor((s) => s.project.height)
  const duration = useEditor((s) => Math.max(1, projectDuration(s.project)))
  const [linked, setLinked] = useState(false)
  const [snapOn, setSnapOn] = useState(true)
  const [stageZoom, setStageZoom] = useState(0.6)
  const miniRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ t0: 0, t1: 1 })
  const trackId = track?.id

  useEffect(() => {
    setView({ t0: -duration * 0.04, t1: duration * 1.04 })
    setLinked(false)
    setStageZoom(0.6)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setStageZoom((z) => Math.min(3, Math.max(0.15, z * Math.exp(-e.deltaY * 0.0015))))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [trackId])

  useEffect(() => {
    const el = miniRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setView((v) => {
        const span = v.t1 - v.t0
        if (e.shiftKey) {
          const d = span * 0.0015 * e.deltaY
          return { t0: v.t0 + d, t1: v.t1 + d }
        }
        const r = el.getBoundingClientRect()
        const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
        const at = v.t0 + span * f
        const ns = Math.min(span * 8 + 0.0001, Math.max(0.1, span * Math.exp(e.deltaY * 0.0015)))
        return { t0: at - ns * f, t1: at + ns * (1 - f) }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [trackId])

  if (!track) {
    queueMicrotask(() => useEditor.getState().setMotionTrack(null))
    return null
  }
  const motion = track.motion ?? defaultMotion()
  let rel = Math.max(0, playhead)
  if (rel < KF_EPS) rel = 0

  const push = (label: string) => useEditor.getState().pushHistory(label)

  const writeMotion = (patch: Partial<Transform3D>) => {
    const st = useEditor.getState()
    const cur = st.project.tracks.find((tr) => tr.id === track.id)?.motion ?? defaultMotion()
    st.updateTrack(track.id, { motion: { ...cur, ...patch } })
  }

  const write = (p: MDef, value: number) => {
    const st = useEditor.getState()
    const cur = st.project.tracks.find((tr) => tr.id === track.id)?.motion ?? defaultMotion()
    writeMotion({ [p.key]: applyValue(cur[p.key], rel, value, linked) } as Partial<Transform3D>)
  }

  const toggleLink = () => {
    const next = !linked
    setLinked(next)
    if (!next) return
    push('hKeyframe')
    const st = useEditor.getState()
    const cur = st.project.tracks.find((tr) => tr.id === track.id)?.motion ?? defaultMotion()
    const patch: Partial<Transform3D> = {}
    for (const p of M_PARAMS) {
      const a = cur[p.key]
      if (a.keyframes?.length) continue
      patch[p.key] = {
        ...a,
        keyframes: [{ time: rel, value: evalAnim(a, rel), easing: 'linear' }]
      }
    }
    if (Object.keys(patch).length) writeMotion(patch)
  }

  const smoothOn = M_PARAMS.some((p) => motion[p.key].smooth)
  const toggleSmooth = () => {
    push('hEdit')
    const patch: Partial<Transform3D> = {}
    for (const p of M_PARAMS) patch[p.key] = { ...motion[p.key], smooth: !smoothOn }
    writeMotion(patch)
  }

  const resetAll = () => {
    push('hEdit')
    const patch: Partial<Transform3D> = {}
    for (const p of M_PARAMS) patch[p.key] = resetValue(motion[p.key], rel, p.def)
    writeMotion(patch)
  }

  const kfTimes = (() => {
    const times: number[] = []
    for (const p of M_PARAMS) {
      for (const kf of motion[p.key].keyframes ?? []) {
        if (!times.some((x) => Math.abs(x - kf.time) < KF_EPS)) times.push(kf.time)
      }
    }
    return times.sort((a, b) => a - b)
  })()

  const removeKfsAt = (time: number) => {
    push('hKeyframe')
    const patch: Partial<Transform3D> = {}
    for (const p of M_PARAMS) {
      const a = motion[p.key]
      if (!a.keyframes?.length) continue
      const left = a.keyframes.filter((kf) => Math.abs(kf.time - time) >= KF_EPS)
      patch[p.key] = left.length
        ? { ...a, keyframes: left }
        : { ...a, value: evalAnim(a, time), keyframes: undefined }
    }
    writeMotion(patch)
  }

  const retimeKfs = (from: number, to: number) => {
    const patch: Partial<Transform3D> = {}
    const st = useEditor.getState()
    const cur = st.project.tracks.find((tr) => tr.id === track.id)?.motion ?? defaultMotion()
    for (const p of M_PARAMS) {
      const a = cur[p.key]
      if (!a.keyframes?.some((kf) => Math.abs(kf.time - from) < KF_EPS)) continue
      patch[p.key] = {
        ...a,
        keyframes: a.keyframes!
          .map((kf) => (Math.abs(kf.time - from) < KF_EPS ? { ...kf, time: to } : kf))
          .sort((x, y) => x.time - y.time)
      }
    }
    writeMotion(patch)
  }

  const jump = (dir: -1 | 1) => {
    const target =
      dir > 0
        ? kfTimes.find((x) => x > rel + KF_EPS)
        : [...kfTimes].reverse().find((x) => x < rel - KF_EPS)
    if (target !== undefined) useEditor.getState().setPlayhead(target)
  }

  // ---------------------------------------------------------------- stage
  const stageW = Math.max(160, width - 22)
  const stageH = Math.round((stageW * projH) / projW)
  const k = (stageW / projW) * stageZoom
  const cur = {
    x: evalAnim(motion.x, rel),
    y: evalAnim(motion.y, rel),
    scale: evalAnim(motion.scale, rel),
    rotation: evalAnim(motion.rotation, rel),
    rotX: evalAnim(motion.rotX, rel),
    rotY: evalAnim(motion.rotY, rel)
  }
  const layerW = Math.max(8, projW * cur.scale * k)
  const layerH = Math.max(8, projH * cur.scale * k)
  const cx = stageW / 2 + cur.x * k
  const cy = stageH / 2 + cur.y * k
  const frameW = projW * k
  const frameH = projH * k

  const byKey = (key: keyof Transform3D) => M_PARAMS.find((p) => p.key === key)!

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    push(linked ? 'hKeyframe' : 'hEdit')
    const x0 = cur.x
    const y0 = cur.y
    const tol = snapOn ? 7 / k : 0
    windowDrag(e, (dx, dy) => {
      const sx = snap1(x0 + dx / k, [0], tol)
      const sy = snap1(y0 + dy / k, [0], tol)
      write(byKey('x'), sx)
      write(byKey('y'), sy)
    })
  }

  const startScale = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    push(linked ? 'hKeyframe' : 'hEdit')
    const r = stageRef.current!.getBoundingClientRect()
    const pcx = r.left + cx
    const pcy = r.top + cy
    const d0 = Math.max(4, Math.hypot(e.clientX - pcx, e.clientY - pcy))
    const s0 = cur.scale
    windowDrag(e, (_dx, _dy, ev) => {
      const d1 = Math.max(4, Math.hypot(ev.clientX - pcx, ev.clientY - pcy))
      let ns = s0 * (d1 / d0)
      if (snapOn && Math.abs(ns - 1) < 0.04) ns = 1
      write(byKey('scale'), ns)
    })
  }

  const startRotate = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    push(linked ? 'hKeyframe' : 'hEdit')
    const r = stageRef.current!.getBoundingClientRect()
    const pcx = r.left + cx
    const pcy = r.top + cy
    const a0 = (Math.atan2(e.clientY - pcy, e.clientX - pcx) * 180) / Math.PI
    const r0 = cur.rotation
    windowDrag(e, (_dx, _dy, ev) => {
      const a1 = (Math.atan2(ev.clientY - pcy, ev.clientX - pcx) * 180) / Math.PI
      let nr = r0 + (a1 - a0)
      if (ev.shiftKey) nr = Math.round(nr / 15) * 15
      if (snapOn) {
        const m45 = Math.round(nr / 45) * 45
        if (Math.abs(nr - m45) < 4) nr = m45
      }
      write(byKey('rotation'), nr)
    })
  }

  const startOrbit = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    push(linked ? 'hKeyframe' : 'hEdit')
    const rx0 = cur.rotX
    const ry0 = cur.rotY
    windowDrag(e, (dx, dy) => {
      let nry = ry0 + dx * 0.4
      let nrx = rx0 - dy * 0.4
      if (snapOn) {
        const my = Math.round(nry / 45) * 45
        if (Math.abs(nry - my) < 4) nry = my
        const mx = Math.round(nrx / 45) * 45
        if (Math.abs(nrx - mx) < 4) nrx = mx
      }
      write(byKey('rotY'), nry)
      write(byKey('rotX'), nrx)
    })
  }

  const span = Math.max(0.001, view.t1 - view.t0)
  const pos = (tt: number) => ((tt - view.t0) / span) * 100
  const timeAt = (clientX: number, lane: HTMLElement) => {
    const r = lane.getBoundingClientRect()
    return view.t0 + ((clientX - r.left) / r.width) * span
  }

  const onKf = kfTimes.some((x) => Math.abs(x - rel) < KF_EPS)

  return (
    <div className="anim-editor">
      <div className="anim-toolbar">
        <span className="motion-title">{t('trackMotion')} — {track.name}</span>
        <span className="flex1" />
        <button
          className={`link-toggle ${linked ? 'on' : ''}`}
          title={t('linkHint')}
          onClick={toggleLink}
        >
          {linked ? '🔗' : '⛓'} {t('linkToTimeline')}
        </button>
      </div>
      <div className="anim-toolbar">
        <label className="anim-check">
          <input type="checkbox" checked={smoothOn} onChange={toggleSmooth} />
          {t('smoothMotion')}
        </label>
        <span className="flex1" />
        <button className={snapOn ? 'active' : ''} title={t('snapToggle')} onClick={() => setSnapOn(!snapOn)}>
          🧲
        </button>
        <button onClick={resetAll}>{t('ctxRestoreView')}</button>
      </div>

      <div className="anim-stage" ref={stageRef} style={{ width: stageW, height: stageH }}>
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
          className="anim-layer motion-layer"
          style={{
            width: layerW,
            height: layerH,
            left: cx - layerW / 2,
            top: cy - layerH / 2,
            transform:
              `perspective(900px) rotateX(${-cur.rotX}deg) ` +
              `rotateY(${cur.rotY}deg) rotate(${cur.rotation}deg)`
          }}
          onPointerDown={startMove}
        >
          <div className="motion-layer-label">{track.name}</div>
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
          <div className="orbit-handle" onPointerDown={startOrbit} title={t('orbitHint')} />
        </div>
        <div className="stage-cross" />
        <div className="stage-zoom dim">
          {Math.round(stageZoom * 100)}%
          <button onClick={() => setStageZoom(0.6)} title="reset">⟲</button>
        </div>
      </div>

      <div className="anim-values">
        {M_PARAMS.map((p) => (
          <label key={p.key} title={t(p.label)}>
            <span>{t(p.label)}</span>
            <input
              type="number"
              step={p.step}
              value={Number(evalAnim(motion[p.key], rel).toFixed(3))}
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
            t={rel.toFixed(2)}s · {t('frameLbl')} {Math.floor(rel * fps)}
          </span>
          <span className="flex1" />
          <button title={t('toClipStart')} onClick={() => useEditor.getState().setPlayhead(0)}>|◀</button>
          <button title={t('kfPrev')} onClick={() => jump(-1)}>◀</button>
          <button title={t('kfDelete')} disabled={!onKf} onClick={() => removeKfsAt(rel)}>◆✕</button>
          <button title={t('kfNext')} onClick={() => jump(1)}>▶</button>
          <button title={t('toClipEnd')} onClick={() => useEditor.getState().setPlayhead(duration)}>▶|</button>
        </div>
        <div className="mini-row">
          <span className="mini-label">{t('trackMotion')}</span>
          <div
            className="mini-lane"
            onPointerDown={(e) => {
              const lane = e.currentTarget
              useEditor.getState().setPlayhead(Math.max(0, timeAt(e.clientX, lane)))
              windowDrag(e, (_dx, _dy, ev) => {
                useEditor.getState().setPlayhead(Math.max(0, timeAt(ev.clientX, lane)))
              })
            }}
          >
            <div
              className="mini-band"
              style={{
                left: `${Math.max(0, pos(0))}%`,
                width: `${Math.max(0, Math.min(100, pos(duration)) - Math.max(0, pos(0)))}%`
              }}
            />
            {kfTimes
              .filter((tt) => pos(tt) >= -1 && pos(tt) <= 101)
              .map((tt) => (
                <div
                  key={tt}
                  className={`mini-kf ${Math.abs(tt - rel) < KF_EPS ? 'on' : ''}`}
                  style={{ left: `${pos(tt)}%` }}
                  title={`${tt.toFixed(2)}s — ${t('kfDragHint')}`}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return
                    e.stopPropagation()
                    e.preventDefault()
                    const lane = (e.currentTarget as HTMLElement).closest('.mini-lane') as HTMLElement
                    let cur0 = tt
                    let pushed = false
                    useEditor.getState().setKfMarker(tt)
                    windowDrag(
                      e,
                      (_dx, _dy, ev) => {
                        if (!pushed) {
                          push('hKeyframe')
                          pushed = true
                        }
                        let nt = Math.max(0, timeAt(ev.clientX, lane))
                        const snapPx = (6 / lane.getBoundingClientRect().width) * span
                        for (const sN of [rel, 0, duration]) {
                          if (Math.abs(nt - sN) < snapPx) nt = sN
                        }
                        if (Math.abs(nt - cur0) > 1e-6) {
                          retimeKfs(cur0, nt)
                          cur0 = nt
                        }
                        // mirror the dragged keyframe on the main timeline
                        useEditor.getState().setKfMarker(cur0)
                      },
                      (moved) => {
                        useEditor.getState().setKfMarker(null)
                        if (!moved) useEditor.getState().setPlayhead(tt)
                      }
                    )
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    removeKfsAt(tt)
                  }}
                />
              ))}
            {pos(rel) >= 0 && pos(rel) <= 100 && (
              <div className="mini-ph" style={{ left: `${pos(rel)}%` }} />
            )}
          </div>
        </div>
      </div>
      <div className="anim-hint dim">{t('motionHint')}</div>
    </div>
  )
}
