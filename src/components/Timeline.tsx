import { useEffect, useMemo, useRef, useState } from 'react'
import type { Clip, MediaAsset, Track } from '@shared/types'
import {
  useEditor, useSettings, projectDuration, snapPoints, findClip, withLinked, MAX_ZOOM
} from '@/state/store'
import { useT } from '@/i18n'
import { TRANSITIONS } from '@/gl/transitions'
import { EDGE_TRANSITIONS } from '@/gl/edges'
import { CtxMenu } from './CtxMenu'
import { useTextUi } from './TextTools'
import { useCaptionsUi } from './CaptionsDialog'

/** Transcribe the selected range (Shift-drag on the ruler) into SRT/TXT. */
function TranscribeRangeButton() {
  const t = useT()
  const range = useEditor((s) => s.range)
  return (
    <button
      disabled={!range}
      title={t('transcribeRangeHint')}
      onClick={() => {
        const r = useEditor.getState().range
        if (r) useTextUi.getState().openTranscribe({ kind: 'range', start: r.start, end: r.end })
      }}
    >
      📝 {t('transcribeRange')}
    </button>
  )
}

const HEADER_W = 150
const RULER_H = 28

function niceStep(zoom: number): number {
  // a major tick roughly every 90px
  const raw = 90 / zoom
  const steps = [0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  return steps.find((s) => s >= raw) ?? 600
}

function tickLabel(t: number): string {
  if (t >= 60) return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`
  return `${parseFloat(t.toFixed(2))}s`
}

function snapTime(t: number, points: number[], zoom: number): number {
  const threshold = 10 / zoom
  let best = t
  let bestD = threshold
  for (const p of points) {
    const d = Math.abs(p - t)
    if (d < bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

/** window-level drag helper: calls move(dx, ev) until pointerup */
function windowDrag(
  e: { clientX: number },
  move: (dx: number, ev: PointerEvent) => void,
  done?: () => void
) {
  const startX = e.clientX
  const onMove = (ev: PointerEvent) => move(ev.clientX - startX, ev)
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    done?.()
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

// ---------------------------------------------------------------------------
// decoded waveform cache (per asset)

interface Wf {
  rate: number
  max: Uint8Array
  rms: Uint8Array
  /** display gain so quiet recordings stay visible (Audacity-like view) */
  norm: number
}
const wfCache = new Map<string, Wf>()

function getWaveform(asset: MediaAsset): Wf | null {
  if (!asset.waveform) return null
  let wf = wfCache.get(asset.id)
  if (!wf) {
    const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const max = decode(asset.waveform.max)
    let peak = 0
    for (const v of max) if (v > peak) peak = v
    wf = {
      rate: asset.waveform.rate,
      max,
      rms: decode(asset.waveform.rms),
      norm: Math.min(8, 230 / Math.max(16, peak))
    }
    wfCache.set(asset.id, wf)
  }
  return wf
}

/** Drag the playhead, or — with Shift — select an export range, snapped. */
function startScrubOrRange(e: React.PointerEvent<HTMLDivElement>, lane: HTMLElement) {
  const timeAt = (clientX: number) => {
    const rect = lane.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left) / useEditor.getState().zoom)
  }
  if (e.shiftKey) {
    const st = useEditor.getState()
    const points = snapPoints(st.project, '', st.playhead)
    const anchor = snapTime(timeAt(e.clientX), points, st.zoom)
    windowDrag(e, (_dx, ev) => {
      const s = useEditor.getState()
      const cur = snapTime(timeAt(ev.clientX), points, s.zoom)
      s.setRange({ start: Math.min(anchor, cur), end: Math.max(anchor, cur) })
    })
    return
  }
  useEditor.getState().setPlayhead(timeAt(e.clientX))
  windowDrag(e, (_dx, ev) => {
    useEditor.getState().setPlayhead(timeAt(ev.clientX))
  })
}

interface MenuState {
  x: number
  y: number
  kind: 'track' | 'clip' | 'transition' | 'edge' | 'junction'
  trackId?: string
  trackKind?: Track['kind']
  clipId?: string
  linked?: boolean
  /** edge menus: which clip tip was clicked */
  edge?: 'in' | 'out'
  /** junction menus: [outgoing clip, incoming clip] */
  clipIds?: [string, string]
}


export function Timeline({ height }: { height: number }) {
  const t = useT()
  const tracks = useEditor((s) => s.project.tracks)
  const zoom = useEditor((s) => s.zoom)
  const trackH = useSettings((s) => s.trackH)
  const duration = useEditor((s) => projectDuration(s.project))
  const scrollRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ start: 0, end: 60 })
  const [menu, setMenu] = useState<MenuState | null>(null)

  const contentW = Math.max(800, (duration + 30) * zoom)

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    const updateView = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const z = useEditor.getState().zoom
        setView({
          start: el.scrollLeft / z,
          end: (el.scrollLeft + el.clientWidth - HEADER_W) / z
        })
      })
    }
    updateView()
    el.addEventListener('scroll', updateView)
    const ro = new ResizeObserver(updateView)
    ro.observe(el)

    const onWheel = (e: WheelEvent) => {
      // plain wheel (and Ctrl+wheel) zooms around the cursor; Shift+wheel pans
      if (e.shiftKey) return
      e.preventDefault()
      const s = useEditor.getState()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left - HEADER_W + el.scrollLeft
      const tAtCursor = cx / s.zoom
      const nz = Math.min(MAX_ZOOM, Math.max(4, s.zoom * Math.exp(-e.deltaY * 0.0015)))
      s.setZoom(nz)
      el.scrollLeft = tAtCursor * nz - (e.clientX - rect.left - HEADER_W)
      updateView()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('scroll', updateView)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setView({
      start: el.scrollLeft / zoom,
      end: (el.scrollLeft + el.clientWidth - HEADER_W) / zoom
    })
  }, [zoom])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [menu])

  return (
    <div className="timeline" style={{ height }}>
      <div className="tl-toolbar">
        <button onClick={() => useEditor.getState().addTrack('video')}>{t('addVideoTrack')}</button>
        <button onClick={() => useEditor.getState().addTrack('audio')}>{t('addAudioTrack')}</button>
        <TranscribeRangeButton />
        <button
          title={t('capButtonHint')}
          onClick={() => useCaptionsUi.getState().setOpen(true)}
        >
          ✨ {t('capButton')}
        </button>
        <span className="dim hint-inline">{t('dropHint')}</span>
        <span className="flex1" />
        <label className="zoom-ctl">
          {t('trackHeight')}
          <input
            type="range"
            min={32}
            max={140}
            step={2}
            value={trackH}
            onChange={(e) => useSettings.getState().setTrackH(Number(e.target.value))}
          />
        </label>
        <label className="zoom-ctl">
          {t('zoom')}
          <input
            type="range"
            min={Math.log(4)}
            max={Math.log(MAX_ZOOM)}
            step={0.01}
            value={Math.log(zoom)}
            onChange={(e) => useEditor.getState().setZoom(Math.exp(Number(e.target.value)))}
          />
        </label>
      </div>
      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-content" style={{ width: HEADER_W + contentW }}>
          <RulerRow contentW={contentW} />
          {tracks.map((track) => (
            <TrackRow
              key={track.id}
              track={track}
              trackH={trackH}
              contentW={contentW}
              view={view}
              onMenu={setMenu}
            />
          ))}
          <RangeOverlay />
          <KfMarker />
          <Playhead />
        </div>
      </div>
      {menu && <TrackMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

function TrackMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const t = useT()
  const selCount = useEditor((s) => s.selection.length)
  const transCur = useEditor((s) => {
    if (menu.kind !== 'transition' || !menu.clipId) return null
    const f = findClip(s.project, menu.clipId)
    if (!f) return null
    const tin = f.clip.transitionIn
    // a transitionIn with a duration is an edge tip — the overlap blends as default
    return tin && tin.duration <= 0.001 ? tin.type : 'crossfade'
  })
  const edgeCur = useEditor((s) => {
    if (menu.kind === 'edge' && menu.clipId) {
      const f = findClip(s.project, menu.clipId)
      const tr = menu.edge === 'in' ? f?.clip.transitionIn : f?.clip.transitionOut
      return tr && tr.duration > 0.001 ? { type: tr.type, duration: tr.duration } : null
    }
    if (menu.kind === 'junction' && menu.clipIds) {
      const b = findClip(s.project, menu.clipIds[1])
      const tr = b?.clip.transitionIn
      return tr && tr.duration > 0.001 ? { type: tr.type, duration: tr.duration } : null
    }
    return null
  })
  if (menu.kind === 'transition') {
    const pick = (type: string) => {
      useEditor.getState().setTransition(menu.clipId!, type)
      onClose()
    }
    return (
      <CtxMenu x={menu.x} y={menu.y} className="trans-menu">
        <div className="ctx-title dim">{t('transition')}</div>
        {TRANSITIONS.map((tr) => (
          <button key={tr.id} onClick={() => pick(tr.id)}>
            <span className="ctx-check">{transCur === tr.id ? '✓' : ''}</span>
            {t(tr.nameKey)}
          </button>
        ))}
        <button onClick={() => pick('none')}>
          <span className="ctx-check">{transCur === 'none' ? '✓' : ''}</span>
          {t('trNone')}
        </button>
      </CtxMenu>
    )
  }
  if (menu.kind === 'edge' || menu.kind === 'junction') {
    const apply = (type: string | null, duration?: number) => {
      const st = useEditor.getState()
      if (menu.kind === 'junction' && menu.clipIds) {
        st.setEdgeTransitions([
          { clipId: menu.clipIds[0], edge: 'out', type, duration },
          { clipId: menu.clipIds[1], edge: 'in', type, duration }
        ])
      } else if (menu.clipId && menu.edge) {
        st.setEdgeTransitions([{ clipId: menu.clipId, edge: menu.edge, type, duration }])
      }
    }
    const title =
      menu.kind === 'junction' ? t('edgeJunction') : menu.edge === 'in' ? t('edgeIn') : t('edgeOut')
    return (
      <CtxMenu x={menu.x} y={menu.y} className="trans-menu">
        <div className="ctx-title dim">{title}</div>
        {EDGE_TRANSITIONS.map((ed) => (
          <button key={ed.id} onClick={() => { apply(ed.id); onClose() }}>
            <span className="ctx-check">{edgeCur?.type === ed.id ? '✓' : ''}</span>
            {t(ed.nameKey)}
          </button>
        ))}
        <div className="ctx-dur-row">
          <span className="dim">{t('edgeDuration')}</span>
          {[0.3, 0.5, 1].map((d) => (
            <button
              key={d}
              className={Math.abs((edgeCur?.duration ?? 0.5) - d) < 0.01 ? 'dur-on' : ''}
              onClick={() => {
                if (edgeCur) apply(edgeCur.type, d)
                onClose()
              }}
            >
              {d}s
            </button>
          ))}
        </div>
        {edgeCur && (
          <button className="danger" onClick={() => { apply(null); onClose() }}>
            {t('edNone')}
          </button>
        )}
      </CtxMenu>
    )
  }
  return (
    <CtxMenu x={menu.x} y={menu.y}>
      {menu.kind === 'track' ? (
        <>
          <button
            onClick={() => {
              useEditor.getState().addTrackNear(menu.trackId!)
              onClose()
            }}
          >
            {menu.trackKind === 'video' ? t('addVideoTrack') : t('addAudioTrack')}
          </button>
          <button
            className="danger"
            onClick={() => {
              useEditor.getState().removeTrack(menu.trackId!)
              onClose()
            }}
          >
            {t('deleteTrack')}
          </button>
        </>
      ) : (
        <>
          {menu.linked ? (
            <button
              onClick={() => {
                const st = useEditor.getState()
                st.select(withLinked(st.project, [menu.clipId!]))
                st.toggleLinkSelection()
                onClose()
              }}
            >
              {t('unlinkAV')}
            </button>
          ) : (
            selCount === 2 && (
              <button
                onClick={() => {
                  useEditor.getState().toggleLinkSelection()
                  onClose()
                }}
              >
                {t('linkAV')}
              </button>
            )
          )}
          <button
            onClick={() => {
              const st = useEditor.getState()
              st.setAnimClip(menu.clipId!)
              onClose()
            }}
          >
            {t('animTab')}…
          </button>
          <button
            className="danger"
            onClick={() => {
              const st = useEditor.getState()
              st.select(withLinked(st.project, [menu.clipId!]))
              st.deleteSelection()
              onClose()
            }}
          >
            {t('clipDelete')}
          </button>
        </>
      )}
    </CtxMenu>
  )
}

function RulerRow({ contentW }: { contentW: number }) {
  const zoom = useEditor((s) => s.zoom)
  const step = niceStep(zoom)
  const ticks = useMemo(() => {
    const out: number[] = []
    for (let x = 0; x * step * zoom < contentW; x++) out.push(x * step)
    return out
  }, [step, zoom, contentW])

  return (
    <div className="tl-row" style={{ height: RULER_H }}>
      <div className="tl-head" style={{ width: HEADER_W, height: RULER_H }} />
      <div
        className="ruler"
        style={{ width: contentW, backgroundSize: `${step * zoom}px 100%` }}
        onPointerDown={(e) => startScrubOrRange(e, e.currentTarget)}
      >
        {ticks.map((tt) => (
          <span key={tt} style={{ left: tt * zoom }}>{tickLabel(tt)}</span>
        ))}
      </div>
    </div>
  )
}

function Playhead() {
  const playhead = useEditor((s) => s.playhead)
  const zoom = useEditor((s) => s.zoom)
  return <div className="playhead" style={{ left: HEADER_W + playhead * zoom }} />
}

/** Yellow marker mirroring a keyframe being dragged in a mini-timeline. */
function KfMarker() {
  const kfMarker = useEditor((s) => s.kfMarker)
  const zoom = useEditor((s) => s.zoom)
  if (kfMarker === null) return null
  return (
    <div className="kf-marker" style={{ left: HEADER_W + kfMarker * zoom }}>
      <div className="kf-marker-diamond" />
    </div>
  )
}

function RangeOverlay() {
  const range = useEditor((s) => s.range)
  const zoom = useEditor((s) => s.zoom)
  if (!range) return null

  const dragEdge = (edge: 'start' | 'end') => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    const points = snapPoints(st.project, '', st.playhead)
    const overlay = e.currentTarget.parentElement as HTMLElement
    const contentLeft = overlay.parentElement!.getBoundingClientRect().left
    windowDrag(e, (_dx, ev) => {
      const s = useEditor.getState()
      const r = s.range
      if (!r) return
      const time = snapTime(
        Math.max(0, (ev.clientX - contentLeft - HEADER_W) / s.zoom),
        points,
        s.zoom
      )
      const next = edge === 'start' ? { start: time, end: r.end } : { start: r.start, end: time }
      if (next.end < next.start) [next.start, next.end] = [next.end, next.start]
      s.setRange(next)
    })
  }

  return (
    <div
      className="range-overlay"
      style={{ left: HEADER_W + range.start * zoom, width: (range.end - range.start) * zoom }}
    >
      <div className="range-edge left" onPointerDown={dragEdge('start')} />
      <div className="range-edge right" onPointerDown={dragEdge('end')} />
      <button
        className="range-clear"
        title="Esc"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useEditor.getState().setRange(null)}
      >
        ×
      </button>
    </div>
  )
}

interface ViewWindow {
  start: number
  end: number
}

function TrackRow({
  track, trackH, contentW, view, onMenu
}: {
  track: Track
  trackH: number
  contentW: number
  view: ViewWindow
  onMenu: (m: MenuState) => void
}) {
  const t = useT()
  const reorder = useRef<{ pushed: boolean } | null>(null)

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const assetId = e.dataTransfer.getData('kadr/asset')
    if (!assetId) return
    e.preventDefault()
    const rect = e.currentTarget.getBoundingClientRect()
    const time = Math.max(0, (e.clientX - rect.left) / useEditor.getState().zoom)
    useEditor.getState().insertClipFromAsset(assetId, track.id, time)
  }

  const onLaneDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.ctrlKey) {
      const rect = e.currentTarget.getBoundingClientRect()
      const time = (e.clientX - rect.left) / useEditor.getState().zoom
      useEditor.getState().closeGapAt(track.id, time)
      return
    }
    if (!e.shiftKey) useEditor.getState().select([])
    startScrubOrRange(e, e.currentTarget)
  }

  // drag the header vertically to reorder tracks
  const onHeadDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'BUTTON' || tag === 'INPUT' || e.button !== 0) return
    reorder.current = { pushed: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onHeadMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = reorder.current
    if (!r) return
    for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
      const overId = (el as HTMLElement).dataset?.trackhead
      if (!overId || overId === track.id) continue
      const st = useEditor.getState()
      const to = st.project.tracks.findIndex((tr) => tr.id === overId)
      if (to >= 0) {
        if (!r.pushed) {
          st.pushHistory('hTrack')
          r.pushed = true
        }
        st.moveTrack(track.id, to)
      }
      break
    }
  }
  const onHeadUp = () => {
    reorder.current = null
  }

  return (
    <div className="tl-row" style={{ height: trackH }}>
      <div
        className={`tl-head track-head ${track.kind}`}
        style={{ width: HEADER_W, height: trackH }}
        data-trackhead={track.id}
        onPointerDown={onHeadDown}
        onPointerMove={onHeadMove}
        onPointerUp={onHeadUp}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu({ x: e.clientX, y: e.clientY, kind: 'track', trackId: track.id, trackKind: track.kind })
        }}
      >
        <div className="track-head-row">
          <span className="track-name">{track.name}</span>
          {track.kind === 'video' && (
            <button
              className={track.motion ? 'toggled-on' : ''}
              title={t('trackMotion')}
              onClick={() => useEditor.getState().setMotionTrack(track.id)}
            >
              ✥
            </button>
          )}
          <button
            className={track.muted ? 'toggled' : ''}
            title={t('mute')}
            onClick={() => useEditor.getState().updateTrack(track.id, { muted: !track.muted })}
          >
            {track.muted ? '🔇' : '🔊'}
          </button>
          <button
            className={track.locked ? 'toggled' : ''}
            title={t('lock')}
            onClick={() => useEditor.getState().updateTrack(track.id, { locked: !track.locked })}
          >
            {track.locked ? '🔒' : '🔓'}
          </button>
        </div>
        {trackH >= 46 && (
          <div className="track-gain-row">
            <input
              className="track-gain"
              type="range"
              min={0}
              max={track.kind === 'audio' ? 2 : 1}
              step={0.01}
              value={track.gain}
              title={track.kind === 'audio' ? t('volume') : t('opacity')}
              onPointerDown={(e) => {
                e.stopPropagation()
                useEditor.getState().pushHistory('hEdit')
              }}
              onChange={(e) =>
                useEditor.getState().updateTrack(track.id, { gain: Number(e.target.value) })
              }
            />
            <span className="gain-pct dim">{Math.round(track.gain * 100)}%</span>
          </div>
        )}
      </div>
      <div
        className={`lane ${track.kind}`}
        data-lane={track.id}
        style={{ width: contentW, height: trackH }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('kadr/asset')) e.preventDefault()
        }}
        onDrop={onDrop}
        onPointerDown={onLaneDown}
      >
        {track.clips.map((c) => (
          <ClipView key={c.id} clip={c} track={track} laneHeight={trackH} view={view} onMenu={onMenu} />
        ))}
        <TransitionZones track={track} onMenu={onMenu} />
      </div>
    </div>
  )
}

/**
 * Vegas-style crossed overlap regions (badge picks the blend) plus junction
 * markers on butt joints (badge picks an AE-style edge transition pair).
 */
function TransitionZones({ track, onMenu }: { track: Track; onMenu: (m: MenuState) => void }) {
  const t = useT()
  const zoom = useEditor((s) => s.zoom)
  const zones: { clip: Clip; from: number; to: number }[] = []
  const joints: { a: Clip; b: Clip; at: number }[] = []
  const sorted = [...track.clips].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i]
    let coverEnd = 0
    for (let j = 0; j < i; j++) {
      const aEnd = sorted[j].start + sorted[j].duration
      if (sorted[j].start < b.start && aEnd > b.start) coverEnd = Math.max(coverEnd, aEnd)
    }
    const to = Math.min(coverEnd, b.start + b.duration)
    if (to > b.start + 1e-6) zones.push({ clip: b, from: b.start, to })
    // butt joint: the previous clip ends exactly where this one starts
    const a = sorted[i - 1]
    if (Math.abs(a.start + a.duration - b.start) < 0.02) joints.push({ a, b, at: b.start })
  }
  if (!zones.length && !joints.length) return null
  return (
    <>
      {zones.map((z) => {
        const tin = z.clip.transitionIn
        const type = tin && tin.duration <= 0.001 ? tin.type : 'crossfade'
        const def = TRANSITIONS.find((tr) => tr.id === type)
        const name = type === 'none' ? t('trNone') : t((def ?? TRANSITIONS[0]).nameKey)
        return (
          <div
            key={z.clip.id}
            className={`transition-zone ${type === 'none' ? 'cut' : ''}`}
            style={{ left: z.from * zoom, width: Math.max(2, (z.to - z.from) * zoom) }}
          >
            {track.kind === 'video' && (
              <button
                className="transition-badge"
                title={`${t('transition')}: ${name}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  onMenu({ x: e.clientX, y: e.clientY, kind: 'transition', clipId: z.clip.id })
                }}
              >
                ⤬
              </button>
            )}
          </div>
        )
      })}
      {track.kind === 'video' &&
        joints.map((j) => {
          const tin = j.b.transitionIn
          const def = tin && tin.duration > 0.001
            ? EDGE_TRANSITIONS.find((e) => e.id === tin.type)
            : undefined
          return (
            <button
              key={`${j.a.id}-${j.b.id}`}
              className={`junction-badge ${def ? 'set' : ''}`}
              style={{ left: j.at * zoom }}
              title={`${t('edgeJunction')}${def ? ': ' + t(def.nameKey) : ''}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onMenu({
                  x: e.clientX, y: e.clientY, kind: 'junction', clipIds: [j.a.id, j.b.id]
                })
              }}
            >
              ◈
            </button>
          )
        })}
    </>
  )
}

type DragMode = 'move' | 'in' | 'out'

interface DragState {
  mode: DragMode
  startX: number
  origStart: number
  origEnd: number
  origTrackId: string
  points: number[]
  /** original positions of all selected clips when group-dragging */
  group: { id: string; start: number; trackId: string; kind: Track['kind'] }[] | null
}

function ClipView({
  clip, track, laneHeight, view, onMenu
}: {
  clip: Clip
  track: Track
  laneHeight: number
  view: ViewWindow
  onMenu: (m: MenuState) => void
}) {
  const t = useT()
  const zoom = useEditor((s) => s.zoom)
  const selected = useEditor((s) => s.selection.includes(clip.id))
  const asset = useEditor((s) =>
    clip.assetId ? s.project.assets.find((a) => a.id === clip.assetId) : undefined
  )
  const drag = useRef<DragState | null>(null)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const [levelDrag, setLevelDrag] = useState<number | null>(null)

  const w = clip.duration * zoom
  const speed = clip.speed || 1
  // timeline length of one full pass over the source — the loop period
  const natural =
    asset && asset.kind !== 'image'
      ? Math.max(0.05, asset.duration - clip.inPoint) / speed
      : Infinity
  const loops = isFinite(natural) && clip.duration > natural + 0.01

  // visible slice in clip-local px — waveform drawn 1:1 with device pixels
  const margin = 64
  const vis0 = Math.max(0, Math.floor((view.start - clip.start) * zoom) - margin)
  const vis1 = Math.min(w, Math.ceil((view.end - clip.start) * zoom) + margin)
  const visW = Math.max(0, Math.round(vis1 - vis0))

  useEffect(() => {
    const canvas = waveRef.current
    if (!canvas || !asset || visW <= 0) return
    const wf = getWaveform(asset)
    if (!wf) return
    const dpr = window.devicePixelRatio || 1
    const cw = Math.round(visW * dpr)
    const ch = Math.round((laneHeight - 16) * dpr)
    if (canvas.width !== cw) canvas.width = cw
    if (canvas.height !== ch) canvas.height = ch
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, cw, ch)
    const span = Math.max(0.05, asset.duration - clip.inPoint)
    const mid = ch / 2
    const srcPerPx = speed / (zoom * dpr)
    for (let x = 0; x < cw; x++) {
      const localT = (vis0 + x / dpr) / zoom
      const srcT = clip.inPoint + ((localT * speed) % span)
      const i0 = Math.floor(srcT * wf.rate)
      const i1 = Math.max(i0 + 1, Math.ceil((srcT + srcPerPx) * wf.rate))
      let peak = 0
      let rms = 0
      for (let i = i0; i < i1 && i < wf.max.length; i++) {
        if (wf.max[i] > peak) peak = wf.max[i]
        if (wf.rms[i] > rms) rms = wf.rms[i]
      }
      const ph = Math.max(1, Math.min(1, (peak * wf.norm) / 255) * mid)
      const rh = Math.max(1, Math.min(1, (rms * wf.norm) / 255) * mid)
      ctx.fillStyle = 'rgba(116, 187, 110, 0.65)'
      ctx.fillRect(x, mid - ph, 1, ph * 2)
      ctx.fillStyle = 'rgba(204, 244, 188, 0.95)'
      ctx.fillRect(x, mid - rh, 1, rh * 2)
    }
  }, [asset, zoom, vis0, visW, clip.inPoint, clip.start, speed, laneHeight])

  // -------------------------------------------------------------- main drag
  // window-level listeners: the clip element remounts when it crosses to
  // another track mid-drag, which would kill pointer capture
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0) return
    e.stopPropagation()
    const st = useEditor.getState()
    const linkedIds = withLinked(st.project, [clip.id])
    if (e.ctrlKey) {
      // toggle the clip together with its linked partner
      const sel = new Set(st.selection)
      if (sel.has(clip.id)) linkedIds.forEach((id) => sel.delete(id))
      else linkedIds.forEach((id) => sel.add(id))
      st.select([...sel])
      return
    }
    if (!selected) st.select(linkedIds)

    const rect = e.currentTarget.getBoundingClientRect()
    const lx = e.clientX - rect.left
    const mode: DragMode = lx < 8 && w > 24 ? 'in' : lx > rect.width - 8 && w > 24 ? 'out' : 'move'
    const grabTime = clip.start + lx / st.zoom
    st.pushHistory(mode === 'move' ? 'hMove' : 'hTrim')

    const sel = useEditor.getState().selection
    const group =
      mode === 'move' && sel.length > 1 && sel.includes(clip.id)
        ? sel
            .map((id) => {
              const f = findClip(st.project, id)
              return f ? { id, start: f.clip.start, trackId: f.track.id, kind: f.track.kind } : null
            })
            .filter((x): x is NonNullable<typeof x> => !!x)
        : null

    // keep the grabbed position as a snap target so the clip can come home
    const points = snapPoints(st.project, group ? group.map((g) => g.id) : clip.id, st.playhead)
    points.push(clip.start, clip.start + clip.duration)

    const d: DragState = {
      mode,
      startX: e.clientX,
      origStart: clip.start,
      origEnd: clip.start + clip.duration,
      origTrackId: track.id,
      points,
      group
    }
    drag.current = d
    const clipId = clip.id

    const onMove = (ev: PointerEvent) => {
      const s = useEditor.getState()
      const dt = (ev.clientX - d.startX) / s.zoom
      const origDur = d.origEnd - d.origStart

      if (d.mode === 'move') {
        let ns = d.origStart + dt
        // snap whichever edge actually found a target (closest wins); detect
        // "snapped" by comparing snapTime's input and output directly so
        // float round-trips can't fake a zero-distance candidate
        const nsEnd = ns + origDur
        const c1 = snapTime(ns, d.points, s.zoom)
        const cEnd = snapTime(nsEnd, d.points, s.zoom)
        const d1 = c1 !== ns ? Math.abs(c1 - ns) : Infinity
        const d2 = cEnd !== nsEnd ? Math.abs(cEnd - nsEnd) : Infinity
        if (d1 <= d2 && d1 < Infinity) ns = c1
        else if (d2 < Infinity) ns = cEnd - origDur
        // hovered lane (live track switch without releasing the button)
        let hoverId: string | null = null
        for (const el of document.elementsFromPoint(ev.clientX, ev.clientY)) {
          const id = (el as HTMLElement).dataset?.lane
          if (id) {
            hoverId = id
            break
          }
        }
        if (d.group) {
          const delta = ns - d.origStart
          // shift the whole group across tracks by the grabbed clip's offset
          // within its own track kind (audio partners move in parallel)
          const tracks = s.project.tracks
          const origTrack = tracks.find((tr) => tr.id === d.origTrackId)
          const hovered = hoverId ? tracks.find((tr) => tr.id === hoverId) : undefined
          let offset = 0
          if (origTrack && hovered && hovered.kind === origTrack.kind) {
            const list = tracks.filter((tr) => tr.kind === origTrack.kind)
            offset = list.findIndex((tr) => tr.id === hovered.id) -
                     list.findIndex((tr) => tr.id === origTrack.id)
          }
          s.setClipStarts(d.group.map((g) => {
            let trackId = g.trackId
            if (offset !== 0) {
              const list = tracks.filter((tr) => tr.kind === g.kind)
              const idx = list.findIndex((tr) => tr.id === g.trackId) + offset
              if (list[idx] && !list[idx].locked) trackId = list[idx].id
            }
            return { id: g.id, start: g.start + delta, trackId }
          }))
          return
        }
        const f = findClip(s.project, clipId)
        if (!f) return
        const targetTrack = hoverId ?? f.track.id
        if (f.track.id !== targetTrack || Math.abs(f.clip.start - ns) > 1e-6) {
          s.moveClip(clipId, targetTrack, Math.max(0, ns))
        }
      } else if (d.mode === 'in') {
        s.trimClip(clipId, 'in', snapTime(d.origStart + dt, d.points, s.zoom))
      } else {
        s.trimClip(clipId, 'out', snapTime(d.origEnd + dt, d.points, s.zoom))
      }
    }
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    const onMoveTracked = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 3) moved = true
      onMove(ev)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMoveTracked)
      window.removeEventListener('pointerup', onUp)
      drag.current = null
      // a plain click (no drag) parks the playhead at the click position;
      // dragging keeps the red cursor where it was so clips can snap to it
      if (!moved && mode === 'move') useEditor.getState().setPlayhead(grabTime)
    }
    window.addEventListener('pointermove', onMoveTracked)
    window.addEventListener('pointerup', onUp)
  }

  // ------------------------------------------------------------ fade drags
  const startFadeDrag = (which: 'fadeIn' | 'fadeOut') => (e: React.PointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    if (!selected) st.select([clip.id])
    st.pushHistory('hFade')
    const f0 = (which === 'fadeIn' ? clip.fadeIn : clip.fadeOut) ?? 0
    windowDrag(e, (dx) => {
      const s = useEditor.getState()
      const f = findClip(s.project, clip.id)
      if (!f) return
      const raw = which === 'fadeIn' ? f0 + dx / s.zoom : f0 - dx / s.zoom
      const v = Math.max(0, Math.min(f.clip.duration, raw))
      s.updateClip(clip.id, { [which]: v < 0.06 ? 0 : v } as Partial<Clip>)
    })
  }

  // ---------------------------------------------------- extend/speed drag
  const startExtendDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    if (!selected) st.select([clip.id])
    const speedMode = e.ctrlKey && !!asset && asset.kind !== 'image'
    st.pushHistory(speedMode ? 'hSpeed' : 'hResize')
    const origDur = clip.duration
    const origSpeed = speed
    const points = snapPoints(st.project, clip.id, st.playhead)
    windowDrag(e, (dx) => {
      const s = useEditor.getState()
      const dt = dx / s.zoom
      if (speedMode) {
        // same source span, new tempo — no looping; keyframes/fades rescale
        // along, and the linked audio/video partner changes tempo too
        const srcSpan = origDur * origSpeed
        let nd = Math.max(0.05, origDur + dt)
        if (Math.abs(nd - srcSpan) < 10 / s.zoom) nd = srcSpan // sticky at speed = 1
        const nspeed = Math.min(4, Math.max(0.25, srcSpan / nd))
        s.setClipSpeed(clip.id, nspeed, srcSpan / nspeed)
      } else {
        let nd = Math.max(0.05, origDur + dt)
        // sticky zone at the natural (source) length
        if (isFinite(natural) && Math.abs(nd - natural) < 10 / s.zoom) nd = natural
        const snapped = snapTime(clip.start + nd, points, s.zoom) - clip.start
        if (snapped > 0.05 && Math.abs(snapped - nd) < 10 / s.zoom) nd = snapped
        s.setClipDuration(clip.id, nd) // linked partner follows
      }
    })
  }

  // rubber band: opacity for video clips, gain for audio clips
  const isAudio = track.kind === 'audio'
  const levelMax = isAudio ? 2 : 1
  const level = isAudio ? clip.gain.value : clip.transform.opacity.value
  const levelPad = 7
  const levelUsable = Math.max(4, laneHeight - 8 - levelPad * 2)
  const levelY = levelPad + (1 - Math.min(levelMax, Math.max(0, level)) / levelMax) * levelUsable

  const startLevelDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    st.pushHistory('hEdit')
    const l0 = level
    setLevelDrag(l0)
    windowDrag(
      e,
      (_dx, ev) => {
        // vertical drag; windowDrag gives dx, use ev for dy
        const dy = ev.clientY - (e.clientY as number)
        const nl = Math.min(levelMax, Math.max(0, l0 - (dy / levelUsable) * levelMax))
        setLevelDrag(nl)
        const s = useEditor.getState()
        const f = findClip(s.project, clip.id)
        if (!f) return
        if (isAudio) s.updateClip(clip.id, { gain: { ...f.clip.gain, value: nl } })
        else s.updateClip(clip.id, {
          transform: { ...f.clip.transform, opacity: { ...f.clip.transform.opacity, value: nl } }
        })
      },
      () => setLevelDrag(null)
    )
  }

  const isText = clip.kind === 'text'
  const fadeIn = clip.fadeIn ?? 0
  const fadeOut = clip.fadeOut ?? 0
  const cls = `clip ${track.kind} ${selected ? 'selected' : ''} ${isText ? 'text-clip' : ''} ${clip.kind === 'remotion' ? 'remotion-clip' : ''}`

  // edge (tip) transitions: AE-style effects on the clip head/tail
  const tipIn = clip.transitionIn && clip.transitionIn.duration > 0.001 ? clip.transitionIn : null
  const tipOut = clip.transitionOut && clip.transitionOut.duration > 0.001 ? clip.transitionOut : null
  const openTipMenu = (edge: 'in' | 'out') => (e: React.MouseEvent) => {
    e.stopPropagation()
    onMenu({ x: e.clientX, y: e.clientY, kind: 'edge', clipId: clip.id, edge })
  }

  const loopMarks: number[] = []
  if (loops) {
    for (let k = 1; k * natural < clip.duration; k++) loopMarks.push(k * natural * zoom)
  }

  // fade handles ride along the fade boundary
  const fadeInX = Math.max(0, Math.min(w - 12, fadeIn * zoom - 5))
  const fadeOutX = Math.max(0, Math.min(w - 12, fadeOut * zoom - 5))

  return (
    <div
      className={cls}
      style={{ left: clip.start * zoom, width: Math.max(4, w) }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => {
        e.stopPropagation()
        useEditor.getState().setAnimClip(clip.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const st = useEditor.getState()
        if (!st.selection.includes(clip.id)) st.select(withLinked(st.project, [clip.id]))
        onMenu({
          x: e.clientX, y: e.clientY, kind: 'clip',
          clipId: clip.id, linked: !!clip.linkId, trackKind: track.kind
        })
      }}
    >
      {track.kind === 'video' && asset?.thumbnail && !isText && (
        <img className="clip-thumb" src={asset.thumbnail} alt="" draggable={false} />
      )}
      {track.kind === 'video' && !isText && w > 90 && (asset?.thumbnailEnd || asset?.thumbnail) && (
        <img
          className="clip-thumb end"
          src={asset.thumbnailEnd ?? asset.thumbnail}
          alt=""
          draggable={false}
        />
      )}
      {track.kind === 'audio' && visW > 0 && (
        <canvas ref={waveRef} className="clip-wave" style={{ left: vis0, width: visW }} />
      )}
      <div
        className="level-hit"
        style={{ top: levelY - 4 }}
        title={`${Math.round(level * 100)}%`}
        onPointerDown={startLevelDrag}
      >
        <div className="level-line" />
      </div>
      {levelDrag !== null && (
        <div className="level-badge" style={{ top: Math.max(0, levelY - 22) }}>
          {Math.round(levelDrag * 100)}%
        </div>
      )}
      {fadeIn > 0 && <div className="fade-shade left" style={{ width: fadeIn * zoom }} />}
      {fadeOut > 0 && <div className="fade-shade right" style={{ width: fadeOut * zoom }} />}
      {loopMarks.map((x) => (
        <div key={x} className="loop-mark" style={{ left: x }} title="loop" />
      ))}
      <span className="clip-label">
        {clip.linkId ? '🔗' : ''}
        {isText ? `T: ${clip.text}` : clip.label}
        {speed !== 1 ? ` ×${speed.toFixed(2)}` : ''}
        {loops ? ' ↻' : ''}
      </span>
      {tipIn && <div className="tip-strip left" style={{ width: tipIn.duration * zoom }} />}
      {tipOut && <div className="tip-strip right" style={{ width: tipOut.duration * zoom }} />}
      {track.kind === 'video' && w > 40 && (
        <>
          <div
            className={`clip-tip left ${tipIn ? 'set' : ''}`}
            title={t('edgeTipHint')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={openTipMenu('in')}
          />
          <div
            className={`clip-tip right ${tipOut ? 'set' : ''}`}
            title={t('edgeTipHint')}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={openTipMenu('out')}
          />
        </>
      )}
      <div className="trim-handle left" />
      <div className="trim-handle right" />
      {w > 30 && (
        <>
          <div
            className="fade-handle left"
            style={{ left: fadeInX }}
            title="Fade in"
            onPointerDown={startFadeDrag('fadeIn')}
          />
          <div
            className="fade-handle right"
            style={{ right: fadeOutX }}
            title="Fade out"
            onPointerDown={startFadeDrag('fadeOut')}
          />
          <div
            className="extend-handle"
            title="Drag: resize/loop · Ctrl: speed"
            onPointerDown={startExtendDrag}
          />
        </>
      )}
    </div>
  )
}
