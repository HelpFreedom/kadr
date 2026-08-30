import { useEffect, useMemo, useRef, useState } from 'react'
import { flushSync, createPortal } from 'react-dom'
import type { AudioDefect, Clip, MediaAsset, Track } from '@shared/types'
import {
  useEditor, useSettings, projectDuration, snapPoints, findClip, withLinked, MAX_ZOOM
} from '@/state/store'
import { useT, type TKey } from '@/i18n'
import { TRANSITIONS } from '@/gl/transitions'
import { EDGE_TRANSITIONS } from '@/gl/edges'
import { CtxMenu } from './CtxMenu'
import { reverseClip, useReverseUi } from '@/engine/reverse'
import { normalizeClip, useNormalizeUi } from '@/engine/normalize'
import { dropPayload, dragHasMedia, dropUsable, importDrop } from '@/engine/mediaImport'
import { useTextUi } from './TextTools'
import { useCaptionsUi } from './CaptionsDialog'
import { useNeonWaveUi } from './NeonWaveDialog'
import { useTtsUi } from './TtsDialog'
import { evalAnim } from '@/engine/anim'
import { spanToProject, projectToSrc, type VisibleSpan } from '@/engine/voiceDefects'
import { useVoiceUi, setVerdict, clearVerdict, addUserDefect, setDefectsHidden } from '@/engine/voiceCheck'
import { confirmDefect } from '@/engine/voiceRegen'
import { useDefectsUi, targetRun } from './DefectsDialog'
import { Icon, Spinner } from './icons'
import { token } from '@/theme'
import { logWarn } from '@/engine/log'

/** Neon wave (audio-reactive fragment) from the selected range. */
function NeonWaveButton() {
  const t = useT()
  const range = useEditor((s) => s.range)
  return (
    <button
      disabled={!range}
      data-act="neon-wave"
      title={t('nwButtonHint')}
      onClick={() => useNeonWaveUi.getState().setOpen(true)}
    >
      <Icon name="wave" /> {t('nwButton')}
    </button>
  )
}

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
      data-act="transcribe-range"
    >
      <Icon name="captions" /> {t('transcribeRange')}
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
      // the gain/opacity slider row has its own precise ±1% wheel
      if ((e.target as HTMLElement).closest?.('.track-gain-row')) return
      e.preventDefault()
      const s = useEditor.getState()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left - HEADER_W + el.scrollLeft
      const tAtCursor = cx / s.zoom
      const nz = Math.min(MAX_ZOOM, Math.max(4, s.zoom * Math.exp(-e.deltaY * 0.0015)))
      // commit the new content width NOW: scrollLeft set against the stale
      // (narrower) width gets clamped by the browser, so zooming near the
      // end of a long timeline used to anchor somewhere left of the cursor
      flushSync(() => s.setZoom(nz))
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

  // fallback drop target for the WHOLE timeline: the ruler and the empty
  // space below the tracks must accept media too, not just the lanes
  // (a lane that took the drop leaves the event defaultPrevented)
  const onAnyDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return
    if (e.dataTransfer.types.includes('kadr/asset') || dragHasMedia(e)) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
  }
  const onAnyDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return
    const sc = e.currentTarget
    const rect = sc.getBoundingClientRect()
    const time = Math.max(0,
      (e.clientX - rect.left + sc.scrollLeft - HEADER_W) / useEditor.getState().zoom)
    const assetId = e.dataTransfer.getData('kadr/asset')
    if (assetId) {
      e.preventDefault()
      useEditor.getState().insertClipFromAsset(assetId, null, time)
      return
    }
    const payload = dropPayload(e)
    if (dropUsable(payload)) {
      e.preventDefault()
      void importDrop(payload, { trackId: null, at: time })
    }
  }

  return (
    <div className="timeline" style={{ height }}>
      <div className="tl-toolbar">
        <button data-act="add-video" onClick={() => useEditor.getState().addTrack('video')}>
          <Icon name="plus" size={13} /> {t('addVideoTrack')}
        </button>
        <button data-act="add-audio" onClick={() => useEditor.getState().addTrack('audio')}>
          <Icon name="plus" size={13} /> {t('addAudioTrack')}
        </button>
        <TranscribeRangeButton />
        <button
          data-act="captions"
          title={t('capButtonHint')}
          onClick={() => useCaptionsUi.getState().setOpen(true)}
        >
          <Icon name="glow" /> {t('capButton')}
        </button>
        <NeonWaveButton />
        <button data-act="tts" title={t('ttsButtonHint')}
                onClick={() => useTtsUi.getState().openSettings()}>
          <Icon name="speech" /> {t('ttsButton')}
        </button>
        <DefectButtons />
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
      <div className="tl-scroll" ref={scrollRef} onDragOver={onAnyDragOver} onDrop={onAnyDrop}>
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
          <Markers />
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
            <span className="ctx-check">
              {transCur === tr.id && <Icon name="check" size={13} />}
            </span>
            {t(tr.nameKey)}
          </button>
        ))}
        <button onClick={() => pick('none')}>
          <span className="ctx-check">
            {transCur === 'none' && <Icon name="check" size={13} />}
          </span>
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
            <span className="ctx-check">
              {edgeCur?.type === ed.id && <Icon name="check" size={13} />}
            </span>
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
          {(() => {
            const p = useEditor.getState().project
            const f = findClip(p, menu.clipId!)
            const a = f?.clip.assetId ? p.assets.find((x) => x.id === f.clip.assetId) : null
            if (!a || a.kind === 'image' || !a.duration) return null
            const busy = useReverseUi.getState().busy[menu.clipId!]
            if (busy !== undefined) {
              return (
                <button disabled>
                  <Spinner size={14} /> {t('reversing')} {Math.round(busy * 100)}%
                </button>
              )
            }
            return (
              <button
                onClick={() => {
                  void reverseClip(menu.clipId!)
                  onClose()
                }}
              >
                {a.reverseOf ? t('unreverse') : t('reverse')}
              </button>
            )
          })()}
          {(() => {
            const p = useEditor.getState().project
            const f = findClip(p, menu.clipId!)
            const a = f?.clip.assetId ? p.assets.find((x) => x.id === f.clip.assetId) : null
            if (!a?.hasAudio) return null
            if (useNormalizeUi.getState().busy[menu.clipId!]) {
              return <button disabled><Spinner size={14} /> {t('normalizing')}…</button>
            }
            return (
              <button
                onClick={() => {
                  normalizeClip(menu.clipId!).catch((err) =>
                    logWarn('громкость', 'нормализовать не удалось', err)
                  )
                  onClose()
                }}
              >
                {t('normalize')}
              </button>
            )
          })()}
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

/** Track-independent user markers: M adds one at the playhead, the flag
    drags along the timeline (snapping), right-click removes. */
function Markers() {
  const markers = useEditor((s) => s.project.markers)
  const zoom = useEditor((s) => s.zoom)
  const t = useT()
  if (!markers?.length) return null
  return (
    <>
      {markers.map((m) => (
        <div
          key={m.id}
          className="tl-marker"
          style={{ left: HEADER_W + m.time * zoom }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            const st = useEditor.getState()
            st.pushHistory('hMarkerMove')
            const points = snapPoints(st.project, '', st.playhead)
            const startX = e.clientX
            const t0 = m.time
            windowDrag(e, (_dx, ev) => {
              const s = useEditor.getState()
              s.moveMarker(m.id, snapTime(t0 + (ev.clientX - startX) / s.zoom, points, s.zoom))
            })
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            useEditor.getState().removeMarker(m.id)
          }}
        >
          <span className="tl-marker-flag" title={t('markerTip')}>{m.label}</span>
        </div>
      ))}
    </>
  )
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

// groups a burst of wheel notches over one gain slider into a single undo entry
const gainWheelMark = { id: '', ts: 0 }

// Ctrl-drag speed range and the round multipliers the drag snaps to.
// Preview playback is clamped to Chromium's 0.0625–16× element range and
// relies on resync seeks beyond it; export is exact at any speed.
const SPEED_MIN = 0.02
const SPEED_MAX = 100
const SPEED_SNAPS = [
  0.05, 0.1, 0.2, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10,
  12, 16, 20, 25, 32, 50, 64, 100
]

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
  const gainRef = useRef<HTMLInputElement>(null)

  // wheel over the volume/opacity slider: precise ±1% per notch (a drag can't
  // hit exact values); consecutive notches merge into one history entry
  useEffect(() => {
    const el = gainRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation() // the timeline zoom listener must not see this
      const st = useEditor.getState()
      const tr = st.project.tracks.find((x) => x.id === track.id)
      if (!tr) return
      const now = Date.now()
      if (gainWheelMark.id !== track.id || now - gainWheelMark.ts > 1000) st.pushHistory('hEdit')
      gainWheelMark.id = track.id
      gainWheelMark.ts = now
      const max = tr.kind === 'audio' ? 2 : 1
      const next = Math.round((tr.gain + (e.deltaY < 0 ? 0.01 : -0.01)) * 100) / 100
      st.updateTrack(track.id, { gain: Math.min(max, Math.max(0, next)) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [track.id, trackH < 46]) // the slider row mounts only when tall enough

  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const time = Math.max(0, (e.clientX - rect.left) / useEditor.getState().zoom)
    const assetId = e.dataTransfer.getData('kadr/asset')
    if (assetId) {
      e.preventDefault()
      useEditor.getState().insertClipFromAsset(assetId, track.id, time)
      return
    }
    // files (or browser image URLs / raw image data) dropped from outside:
    // import into the bin AND lay them out back-to-back from the drop point
    // (audio goes to an audio track; remote URLs are downloaded first)
    const payload = dropPayload(e)
    if (dropUsable(payload)) {
      e.preventDefault()
      void importDrop(payload, { trackId: track.id, at: time })
    }
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
              data-act="track-motion"
              title={t('trackMotion')}
              aria-label={t('trackMotion')}
              onClick={() => useEditor.getState().setMotionTrack(track.id)}
            >
              <Icon name="move" size={13} />
            </button>
          )}
          <button
            className={track.muted ? 'toggled' : ''}
            data-act="mute"
            title={t('mute')}
            aria-label={t('mute')}
            aria-pressed={track.muted}
            onClick={() => useEditor.getState().updateTrack(track.id, { muted: !track.muted })}
          >
            <Icon name={track.muted ? 'mute' : 'volume'} size={13} />
          </button>
          <button
            className={track.locked ? 'toggled' : ''}
            data-act="lock"
            title={t('lock')}
            aria-label={t('lock')}
            aria-pressed={track.locked}
            onClick={() => useEditor.getState().updateTrack(track.id, { locked: !track.locked })}
          >
            <Icon name={track.locked ? 'lock' : 'unlock'} size={13} />
          </button>
        </div>
        {trackH >= 46 && (
          <div className="track-gain-row">
            <input
              ref={gainRef}
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
          if (e.dataTransfer.types.includes('kadr/asset') || dragHasMedia(e)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={onDrop}
        onPointerDown={onLaneDown}
      >
        {track.clips.map((c) => (
          <ClipView key={c.id} clip={c} track={track} laneHeight={trackH} view={view} onMenu={onMenu} />
        ))}
        <TransitionZones track={track} onMenu={onMenu} />
        <DefectBands track={track} />
      </div>
    </div>
  )
}

/** Run the detector, and mark a defect the detector missed.
 *
 * The manual mark deliberately reuses the in/out range (Shift+drag) instead of
 * a Ctrl-drag on the clip: Ctrl+drag over a clip body is how clips are handled,
 * and stealing it would break moving them. Without a range the playhead does.
 */
function DefectButtons() {
  const t = useT()
  const hasRuns = useEditor((s) => (s.project.voiceRuns?.length ?? 0) > 0)
  const hidden = useVoiceUi((s) => s.hidden)
  const [busy, setBusy] = useState(false)
  if (!hasRuns) return null

  /** Mark from the in/out range, or from the playhead when there is none. */
  const mark = async (kind: 'defect' | 'redo') => {
    const s = useEditor.getState()
    const run = targetRun()
    if (!run) return
    const r = s.range
    const a = r ? r.start : s.playhead
    const b = r ? r.end : s.playhead + 0.15
    // range/playhead are TIMELINE seconds; a defect lives in source time
    const found = s.project.tracks.flatMap((tr) => tr.clips)
      .find((c) => c.assetId === run.assetId && a < c.start + c.duration && b > c.start)
    if (!found) return
    setBusy(true)
    try {
      await addUserDefect(run.assetId, projectToSrc(found, a), projectToSrc(found, b), kind)
    } catch (e) {
      useVoiceUi.setState({ error: String((e as Error)?.message ?? e) })
      useDefectsUi.getState().setOpen(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button data-act="defects" title={t('dfButtonHint')}
              onClick={() => useDefectsUi.getState().setOpen(true)}>
        <Icon name="target" /> {t('dfButton')}
      </button>
      <button data-act="mark-defect" title={`${t('dfUserHint')} · ${t('dfDragHint')}`}
              disabled={busy} onClick={() => mark('defect')}>
        <Icon name="pencil" /> {t('dfUserAdd')}
      </button>
      <button data-act="mark-redo" title={t('dfRedoHint')} disabled={busy}
              onClick={() => mark('redo')}>
        <Icon name="again" /> {t('dfRedoAdd')}
      </button>
      <button className="icon-only" data-act="hide-defects"
              title={hidden ? t('dfShow') : t('dfHide')}
              aria-label={hidden ? t('dfShow') : t('dfHide')}
              aria-pressed={hidden}
              onClick={() => setDefectsHidden(!hidden)}>
        <Icon name={hidden ? 'eyeOff' : 'eye'} />
      </button>
    </>
  )
}

/** ttsqc's classes, for the flag. 'user' is ours, for a hand-placed mark. */
const DEFECT_LABEL: Record<string, TKey> = {
  insert: 'dfInsert', corrupt: 'dfCorrupt', missing: 'dfMissing',
  truncation: 'dfTruncation', stress: 'dfStress', misread: 'dfMisread',
  script_typo: 'dfTypo', region_fail: 'dfRegion', user: 'dfUser',
  // «заново» — это НЕ утверждение о дефекте: фраза перегенерируется, но в
  // корпус не идёт. Своя подпись, свой цвет и свой значок — иначе по метке не
  // отличить, попадёт ли она в обучение
  redo: 'dfRedoCls'
}

/**
 * Audio defects of a voice-over, drawn INSIDE the lane of the clip they belong
 * to — deliberately unlike markers (full-height green flags) and the range
 * (full-height blue band), because a defect is a property of one clip's audio,
 * not of the timeline. Violet is the one unused colour here.
 *
 * The bands themselves are pointer-transparent so dragging the clip underneath
 * still works (the trick `.tl-marker` uses); only the flag and the two phrase
 * edge handles take the mouse.
 */
function DefectBands({ track }: { track: Track }) {
  const t = useT()
  const zoom = useEditor((s) => s.zoom)
  const defects = useEditor((s) => s.project.defects)
  const clips = track.clips
  const busy = useVoiceUi((s) => s.busy)
  const hidden = useVoiceUi((s) => s.hidden)
  const marking = useVoiceUi((s) => s.marking)
  const preview = marking && marking.trackId === track.id ? marking : null
  if (hidden) return null
  if (!defects?.length && !preview) return null

  const placed: Array<{ d: AudioDefect; src: VisibleSpan; phrase: VisibleSpan | null; clipId: string }> = []
  for (const d of defects ?? []) {
    // «не дефект» — метка и выделение уходят с таймлайна. Сама запись остаётся
    // в проекте: это обучающий пример для детектора, и Ctrl+Z вернёт её вид.
    if (d.state === 'rejected') continue
    for (const clip of clips) {
      if (clip.assetId !== d.assetId) continue
      const src = spanToProject(clip, d.src[0], d.src[1])
      if (!src) continue
      placed.push({ d, src, phrase: spanToProject(clip, d.phrase.t0, d.phrase.t1), clipId: clip.id })
    }
  }
  if (!placed.length && !preview) return null

  const dragEdge = (e: React.PointerEvent, d: AudioDefect, edge: 't0' | 't1', clip: Clip) => {
    e.stopPropagation()
    const st = useEditor.getState()
    st.pushHistory('hDefectEdge')
    const startX = e.clientX
    const from = d.phrase[edge]
    windowDrag(e, (_dx, ev) => {
      const s = useEditor.getState()
      const speed = clip.speed || 1
      const next = from + ((ev.clientX - startX) / s.zoom) * speed
      const cur = s.project.defects?.find((x) => x.id === d.id)
      if (!cur) return
      // the phrase must keep containing its defect — that invariant is what the
      // splice stands on, so the handle simply cannot be dragged past it
      const t0 = edge === 't0' ? Math.min(next, cur.src[0]) : cur.phrase.t0
      const t1 = edge === 't1' ? Math.max(next, cur.src[1]) : cur.phrase.t1
      s.updateDefect(d.id, {
        phrase: { ...cur.phrase, t0: Math.max(0, t0), t1, cut: ['fallback', 'fallback'] }
      })
    })
  }

  const dragSrc = (e: React.PointerEvent, d: AudioDefect, edge: 0 | 1, clip: Clip) => {
    e.stopPropagation()
    const st = useEditor.getState()
    st.pushHistory('hDefectEdge')
    const startX = e.clientX
    const from = d.src[edge]
    windowDrag(e, (_dx, ev) => {
      const s = useEditor.getState()
      const speed = clip.speed || 1
      const cur = s.project.defects?.find((x) => x.id === d.id)
      if (!cur) return
      const next = from + ((ev.clientX - startX) / s.zoom) * speed
      // дефект обязан остаться внутри своей фразы и не вывернуться наизнанку
      const lo = cur.phrase.t0
      const hi = cur.phrase.t1
      const src: [number, number] = edge === 0
        ? [Math.min(Math.max(next, lo), cur.src[1] - 0.02), cur.src[1]]
        : [cur.src[0], Math.max(Math.min(next, hi), cur.src[0] + 0.02)]
      s.updateDefect(d.id, { src })
    })
  }

  return (
    <>
      {preview && (
        <div className="adefect marking"
             style={{ left: Math.min(preview.from, preview.to) * zoom,
                      width: Math.max(3, Math.abs(preview.to - preview.from) * zoom) }} />
      )}
      {placed.map(({ d, src, phrase, clipId }) => {
        const clip = clips.find((c) => c.id === clipId)
        const working = busy[d.id] !== undefined
        const label = t(DEFECT_LABEL[d.cls ?? 'user'] ?? 'dfUser')
        const conf = d.confidence === undefined ? '' : ` ${d.confidence.toFixed(2)}`
        const redo = d.cls === 'redo'
        // прямо в подсказке: пойдёт эта отметка в обучение или нет
        const learns = redo ? t('dfNoLearn') : t('dfLearns')
        return (
          <div key={`${d.id}-${clipId}`}>
            {phrase && (
              <div
                className={`adefect-phrase ${d.state}`}
                style={{ left: phrase.start * zoom, width: Math.max(2, (phrase.end - phrase.start) * zoom) }}
              >
                {clip && !phrase.clippedIn && (
                  <span className="adefect-edge left"
                        title={t('dfEdgeTip')}
                        onPointerDown={(e) => dragEdge(e, d, 't0', clip)} />
                )}
                {clip && !phrase.clippedOut && (
                  <span className="adefect-edge right"
                        title={t('dfEdgeTip')}
                        onPointerDown={(e) => dragEdge(e, d, 't1', clip)} />
                )}
              </div>
            )}
            <div
              className={`adefect ${d.state} ${d.origin}${redo ? ' redo' : ''}` +
                `${working ? ' working' : ''}` +
                `${src.clippedIn ? ' clipped-in' : ''}${src.clippedOut ? ' clipped-out' : ''}`}
              data-defect={d.id}
              style={{ left: src.start * zoom, width: Math.max(3, (src.end - src.start) * zoom) }}
            >
              {clip && !src.clippedIn && (
                <span className="adefect-edge src left" title={t('dfSrcEdge')}
                      onPointerDown={(e) => dragSrc(e, d, 0, clip)} />
              )}
              {clip && !src.clippedOut && (
                <span className="adefect-edge src right" title={t('dfSrcEdge')}
                      onPointerDown={(e) => dragSrc(e, d, 1, clip)} />
              )}
            </div>
            <button
              className={`adefect-flag ${d.state} ${d.origin}${redo ? ' redo' : ''}` +
                `${working ? ' working' : ''}`}
              style={{ left: src.start * zoom }}
              title={`${label}${conf}\n${learns}\n${t(redo ? 'dfTipRedo' : 'dfTip')}` +
                `\n${(d.phrase.text || '').slice(0, 120)}`}
              onPointerDown={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.stopPropagation()
                if (!phrase) return
                // прослушать место — главное действие при разборе: ставим
                // диапазон на фразу и сразу запускаем
                const s = useEditor.getState()
                s.setRange({ start: phrase.start, end: phrase.end })
                s.setPlayhead(phrase.start)
                s.setPlaying(true)
              }}
              onClick={(e) => {
                e.stopPropagation()
                // Alt returns it to undecided — a mis-click must be cheap
                if (e.altKey) clearVerdict(d.id)
                else confirmDefect(d.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (d.origin === 'user') useEditor.getState().removeDefects(d.id)
                else setVerdict(d.id, false)
              }}
            >
              {d.state === 'confirmed' || d.state === 'done'
                ? <Icon name="check" size={10} strokeWidth={3} />
                : d.state === 'failed'
                  ? <Icon name="alert" size={10} strokeWidth={2.5} />
                  : redo
                    ? <Icon name="again" size={10} strokeWidth={2.5} />
                    : d.origin === 'user'
                      ? <Icon name="pencil" size={10} strokeWidth={2.5} />
                      : <Icon name="diamond" size={10} strokeWidth={2.5} />}
            </button>
          </div>
        )
      })}
    </>
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
                aria-label={`${t('transition')}: ${name}`}
              >
                <Icon name="transition" size={12} />
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
              aria-label={t('edgeJunction')}
            >
              <Icon name="junction" size={12} />
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
  const reversing = useReverseUi((s) => s.busy[clip.id]) // 0..1 or undefined
  const drag = useRef<DragState | null>(null)
  const waveRef = useRef<HTMLCanvasElement>(null)
  const [levelDrag, setLevelDrag] = useState<number | null>(null)
  // live ×N readout during a Ctrl speed drag; highlighted when snapped
  const [speedBadge, setSpeedBadge] =
    useState<{ x: number; y: number; speed: number; snapped: boolean } | null>(null)

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
      ctx.fillStyle = token('--c-wave-peak')
      ctx.fillRect(x, mid - ph, 1, ph * 2)
      ctx.fillStyle = token('--c-wave-rms')
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
      // Ctrl+drag near EITHER edge = speed (Vegas-style time stretch) —
      // the same gesture as the extend handles, but forgiving about where
      // exactly the clip is grabbed
      const rect = e.currentTarget.getBoundingClientRect()
      const lx = e.clientX - rect.left
      if (w > 24 && asset && asset.kind !== 'image') {
        if (lx > rect.width - 14) {
          startExtendDrag('right')(e)
          return
        }
        if (lx < 14) {
          startExtendDrag('left')(e)
          return
        }
      }
      const toggleSelection = () => {
        const s = useEditor.getState()
        const sel = new Set(s.selection)
        if (sel.has(clip.id)) linkedIds.forEach((id) => sel.delete(id))
        else linkedIds.forEach((id) => sel.add(id))
        s.select([...sel])
      }

      // On a voice-over clip Ctrl+DRAG marks a span for the defect detector —
      // the gesture the work actually needs. A Ctrl+CLICK (no movement) still
      // toggles the selection exactly as before, so nothing is taken away.
      const run = clip.assetId
        ? st.project.voiceRuns?.find((r) => r.assetId === clip.assetId)
        : undefined
      if (run) {
        const box = e.currentTarget.getBoundingClientRect()
        const atX = (x: number) => {
          const s = useEditor.getState()
          const t = clip.start + (x - box.left) / s.zoom
          return Math.min(clip.start + clip.duration, Math.max(clip.start, t))
        }
        const from = atX(e.clientX)
        let moved = false
        useVoiceUi.setState({ marking: { trackId: track.id, from, to: from } })
        windowDrag(e, (_dx, ev) => {
          if (Math.abs(ev.clientX - e.clientX) > 3) moved = true
          useVoiceUi.setState({ marking: { trackId: track.id, from, to: atX(ev.clientX) } })
        }, () => {
          const m = useVoiceUi.getState().marking
          useVoiceUi.setState({ marking: null })
          if (!moved || !m || Math.abs(m.to - m.from) < 0.02) {
            toggleSelection()
            return
          }
          const a = Math.min(m.from, m.to)
          const b = Math.max(m.from, m.to)
          addUserDefect(clip.assetId!, projectToSrc(clip, a), projectToSrc(clip, b))
            .catch((err) => {
              useVoiceUi.setState({ error: String((err as Error)?.message ?? err) })
              useDefectsUi.getState().setOpen(true)
            })
        })
        return
      }
      toggleSelection()
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
  // Works from BOTH clip ends. Right: the start stays put (resize = loop-
  // extend, Ctrl = speed). Left: the RIGHT edge stays anchored (resize =
  // trim-in, Ctrl = speed with the start moving instead).
  const startExtendDrag = (edge: 'left' | 'right') =>
    (e: React.PointerEvent<HTMLDivElement>) => {
    if (track.locked || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const st = useEditor.getState()
    if (!selected) st.select([clip.id])
    const speedMode = e.ctrlKey && !!asset && asset.kind !== 'image'
    const leftTrim = edge === 'left' && !speedMode
    st.pushHistory(speedMode ? 'hSpeed' : leftTrim ? 'hTrim' : 'hResize')
    const origStart = clip.start
    const origEnd = clip.start + clip.duration
    const origDur = clip.duration
    const origSpeed = speed
    // exclude the linked twin from snap targets — it follows the drag
    const points = snapPoints(st.project, withLinked(st.project, [clip.id]), st.playhead)
    windowDrag(e, (dx, ev) => {
      const s = useEditor.getState()
      const dt = dx / s.zoom
      if (speedMode) {
        // same source span, new tempo — no looping; keyframes/fades rescale
        // along, and the linked audio/video partner changes tempo too
        const srcSpan = origDur * origSpeed
        let nd = edge === 'right'
          ? Math.max(0.05, origDur + dt)
          : Math.min(origEnd, Math.max(0.05, origDur - dt)) // start may not go below 0
        // snap within ~16 px: to round multipliers AND to the edges of the
        // other clips / the playhead — the closest candidate wins
        let snapped = false
        let bestGap = 16 / s.zoom
        let snapNd = nd
        const consider = (candNd: number) => {
          const gap = Math.abs(candNd - nd)
          if (candNd > 0.05 && gap < bestGap) {
            bestGap = gap
            snapNd = candNd
            snapped = true
          }
        }
        for (const cand of SPEED_SNAPS) consider(srcSpan / cand)
        // the MOVING edge lands on a timeline point
        for (const p of points) consider(edge === 'right' ? p - origStart : origEnd - p)
        if (snapped) nd = snapNd
        const nspeed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, srcSpan / nd))
        setSpeedBadge({ x: ev.clientX, y: ev.clientY, speed: nspeed, snapped })
        s.setClipSpeed(clip.id, nspeed, srcSpan / nspeed,
          edge === 'left' ? origEnd - srcSpan / nspeed : undefined)
      } else if (leftTrim) {
        // same semantics as dragging the clip's left trim edge: content
        // stays in place, inPoint compensates, source start clamps
        s.trimClip(clip.id, 'in', snapTime(origStart + dt, points, s.zoom))
      } else {
        let nd = Math.max(0.05, origDur + dt)
        // sticky zone at the natural (source) length
        if (isFinite(natural) && Math.abs(nd - natural) < 10 / s.zoom) nd = natural
        const snapped = snapTime(origStart + nd, points, s.zoom) - origStart
        if (snapped > 0.05 && Math.abs(snapped - nd) < 10 / s.zoom) nd = snapped
        s.setClipDuration(clip.id, nd) // linked partner follows
      }
    }, () => setSpeedBadge(null))
  }

  // rubber band: opacity for video clips, gain for audio clips
  const isAudio = track.kind === 'audio'
  const levelMax = isAudio ? 2 : 1
  const level = isAudio ? evalAnim(clip.gain, 0) : evalAnim(clip.transform?.opacity, 0)
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
        {clip.kind === 'remotion' && <Icon name="atom" size={11} />}
        {clip.linkId && <Icon name="link" size={11} />}
        <span>
          {isText ? `T: ${clip.text}` : clip.label}
          {speed !== 1 ? ` ×${speed.toFixed(2)}` : ''}
        </span>
        {loops && <Icon name="loop" size={11} />}
        {reversing !== undefined
          ? <><Spinner size={11} /> {Math.round(reversing * 100)}%</>
          : asset?.reverseOf
            ? <Icon name="rewind" size={11} />
            : null}
      </span>
      {reversing !== undefined && (
        <div className="reverse-progress" style={{ width: `${Math.round(reversing * 100)}%` }} />
      )}
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
            onPointerDown={startExtendDrag('right')}
          />
          <div
            className="extend-handle left"
            title="Drag: resize · Ctrl: speed"
            onPointerDown={startExtendDrag('left')}
          />
        </>
      )}
      {speedBadge && createPortal(
        <div
          className={speedBadge.snapped ? 'speed-badge snapped' : 'speed-badge'}
          style={{ left: speedBadge.x + 14, top: speedBadge.y - 30 }}
        >
          ×{speedBadge.speed.toFixed(2)}
        </div>,
        document.body
      )}
    </div>
  )
}
