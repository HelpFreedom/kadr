import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useEditor } from '@/state/store'
import { dirOf } from '@shared/paths'
import { activity } from '@/engine/autosave'
import { useT } from '@/i18n'

// panel position/size, persisted across launches; null = the default CSS
// placement (docked to the right edge)
const RECT_KEY = 'kadr.claudeRect'
type PanelRect = { x: number; y: number; w: number; h: number }
const MIN_W = 340
const MIN_H = 220

function clampRect(r: PanelRect): PanelRect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(MIN_W, Math.min(r.w, vw - 16))
  const h = Math.max(MIN_H, Math.min(r.h, vh - 16))
  // keep the header reachable: at least 120px of it inside the viewport
  const x = Math.max(120 - w, Math.min(r.x, vw - 120))
  const y = Math.max(0, Math.min(r.y, vh - 60))
  return { x, y, w, h }
}

function loadRect(): PanelRect | null {
  try {
    const r = JSON.parse(localStorage.getItem(RECT_KEY) || 'null')
    if (r && [r.x, r.y, r.w, r.h].every(Number.isFinite)) return clampRect(r)
  } catch { /* corrupt value — fall back to default placement */ }
  return null
}

/**
 * Embedded Claude Code session: an xterm terminal driven by a PTY in the
 * main process running the user's `claude` CLI, with the kadr MCP server
 * wired to this very editor instance. Closing the panel kills the session.
 */
export function ClaudePanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  const holder = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<PanelRect | null>(loadRect)

  // shared drag plumbing for the header (move) and the edge handles (resize)
  const trackDrag = (
    e: React.PointerEvent,
    apply: (dx: number, dy: number, r0: PanelRect) => PanelRect
  ) => {
    e.preventDefault()
    const b = panelRef.current!.getBoundingClientRect()
    const r0: PanelRect = rect ?? { x: b.left, y: b.top, w: b.width, h: b.height }
    const sx = e.clientX
    const sy = e.clientY
    let last = r0
    const move = (ev: PointerEvent) => {
      last = clampRect(apply(ev.clientX - sx, ev.clientY - sy, r0))
      setRect(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      localStorage.setItem(RECT_KEY, JSON.stringify(last))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'BUTTON') return
    trackDrag(e, (dx, dy, r0) => ({ ...r0, x: r0.x + dx, y: r0.y + dy }))
  }

  const startResize =
    (edges: { l?: boolean; r?: boolean; b?: boolean }) => (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.stopPropagation()
      trackDrag(e, (dx, dy, r0) => {
        let { x, w, h } = r0
        if (edges.r) w = r0.w + dx
        if (edges.b) h = r0.h + dy
        if (edges.l) {
          w = Math.max(MIN_W, r0.w - dx)
          x = r0.x + r0.w - w // the right edge stays put
        }
        return { x, y: r0.y, w, h }
      })
    }

  // NB: the effect must be fully re-entrant — React StrictMode mounts it
  // twice in dev (mount → cleanup → mount), and a one-shot guard would
  // leave the panel attached to a session the cleanup already killed
  useEffect(() => {
    if (!holder.current) return
    activity.claude = true
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'monospace',
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: '#101218',
        foreground: '#d8dce6',
        cursor: '#7fc4ff'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(holder.current)
    fit.fit()

    const offData = window.kadr.onClaudeData((data) => term.write(data))
    const offExit = window.kadr.onClaudeExit(() => {
      term.write(`\r\n\x1b[90m${t('claudeExited')}\x1b[0m\r\n`)
    })
    const onData = term.onData((data) => window.kadr.claudeInput(data))

    const ro = new ResizeObserver(() => {
      fit.fit()
      window.kadr.claudeResize(term.cols, term.rows)
    })
    ro.observe(holder.current)

    const projectPath = useEditor.getState().projectPath
    const cwd = projectPath ? dirOf(projectPath) : null
    let dead = false
    window.kadr.claudeOpen(term.cols, term.rows, cwd).then((r) => {
      if (dead) return
      if (!r.ok) {
        term.write(`\x1b[31m${t('claudeFailed')}: ${r.error ?? ''}\x1b[0m\r\n`)
      } else {
        term.focus()
      }
    })
    term.focus()

    return () => {
      dead = true
      activity.claude = false
      ro.disconnect()
      onData.dispose()
      offData()
      offExit()
      window.kadr.claudeClose()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="claude-panel"
      ref={panelRef}
      style={rect
        ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, right: 'auto', bottom: 'auto' }
        : undefined}
    >
      <div className="claude-head" onPointerDown={startMove}>
        <span>🤖 Claude Code</span>
        <span className="dim claude-hint">{t('claudeHint')}</span>
        <button className="claude-close" title={t('claudeClose')} onClick={onClose}>✕</button>
      </div>
      <div className="claude-term" ref={holder} />
      <div className="claude-rs l" onPointerDown={startResize({ l: true })} />
      <div className="claude-rs r" onPointerDown={startResize({ r: true })} />
      <div className="claude-rs b" onPointerDown={startResize({ b: true })} />
      <div className="claude-rs bl" onPointerDown={startResize({ l: true, b: true })} />
      <div className="claude-rs br" onPointerDown={startResize({ r: true, b: true })} />
    </div>
  )
}
