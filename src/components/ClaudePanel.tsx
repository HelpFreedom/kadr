import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useEditor } from '@/state/store'
import { dirOf } from '@shared/paths'
import { activity } from '@/engine/autosave'
import { useT } from '@/i18n'
import { token } from '@/theme'
import type { ClaudeChatInfo } from '@shared/types'
import { Icon } from './icons'

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
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, select')) return
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

  // The project's chats (Project.claudeChats; the transcripts travel in the
  // .kadr file). `want` is the chat the terminal runs — null starts a new one,
  // and every new object restarts the session; undefined = still listing.
  const [chats, setChats] = useState<ClaudeChatInfo[]>([])
  const [current, setCurrent] = useState<string | null>(null)
  const [want, setWant] = useState<{ id: string | null }>()
  const listChats = () => window.kadr.claudeChats(useEditor.getState().project.claudeChats ?? [])

  // open on the project's latest chat, or a new one when it has none
  useEffect(() => {
    let gone = false
    void listChats().then((list) => {
      if (gone) return
      setChats(list)
      setWant({ id: list[0]?.id ?? null })
    })
    return () => { gone = true }
  }, [])

  // NB: the effect must be fully re-entrant — React StrictMode mounts it
  // twice in dev (mount → cleanup → mount), and a one-shot guard would
  // leave the panel attached to a session the cleanup already killed
  useEffect(() => {
    if (!holder.current || !want) return
    activity.claude = true
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'monospace',
      cursorBlink: true,
      convertEol: false,
      theme: {
        background: token('--c-term-bg', '#0a0c11'),
        foreground: token('--c-term-fg', '#e6e9ef'),
        cursor: token('--c-term-cursor', '#6a8cff')
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
    // Ctrl+V: xterm would send ^V; let the browser paste into xterm's textarea
    // instead — xterm's paste listener forwards it (bracketed paste included)
    term.attachCustomKeyEventHandler((e) => !(e.type === 'keydown' && e.ctrlKey && e.code === 'KeyV'))
    // Electron has no context menu: right-click copies a selection or pastes,
    // as in Windows Terminal
    const el = holder.current
    // the chat joins the project on the user's first key or paste — not at
    // spawn: a panel opened and closed again leaves no empty chat behind
    let chatId: string | undefined
    let noted = false
    const note = () => {
      if (!chatId || noted) return
      noted = true
      useEditor.getState().noteClaudeChat(chatId)
    }
    const onContext = (e: MouseEvent) => {
      e.preventDefault()
      if (term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        term.clearSelection()
      } else {
        void navigator.clipboard.readText().then((s) => { if (s) { note(); term.paste(s) } })
      }
    }
    el.addEventListener('contextmenu', onContext)
    el.addEventListener('keydown', note, true) // capture: xterm stops the keydown's propagation

    const ro = new ResizeObserver(() => {
      fit.fit()
      window.kadr.claudeResize(term.cols, term.rows)
    })
    ro.observe(holder.current)

    const projectPath = useEditor.getState().projectPath
    const cwd = projectPath ? dirOf(projectPath) : null
    let dead = false
    window.kadr.claudeOpen(term.cols, term.rows, cwd, want.id).then((r) => {
      if (dead) return
      if (!r.ok) {
        term.write(`\x1b[31m${t('claudeFailed')}: ${r.error ?? ''}\x1b[0m\r\n`)
      } else {
        chatId = r.chatId
        setCurrent(r.chatId ?? null)
        term.focus()
      }
    })
    term.focus()

    return () => {
      dead = true
      activity.claude = false
      ro.disconnect()
      el.removeEventListener('contextmenu', onContext)
      el.removeEventListener('keydown', note, true)
      onData.dispose()
      offData()
      offExit()
      window.kadr.claudeClose()
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want])

  const fmt = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  // a chat started just now has no transcript until its first message
  const options = current && !chats.some((c) => c.id === current)
    ? [{ id: current, title: '', updated: 0 }, ...chats]
    : chats

  return (
    <div
      className="claude-panel"
      ref={panelRef}
      style={rect
        ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h, right: 'auto', bottom: 'auto' }
        : undefined}
    >
      <div className="claude-head" onPointerDown={startMove} title={t('claudeHint')}>
        <span><Icon name="bot" size={15} /> Claude Code</span>
        <select
          className="claude-chat"
          title={t('claudeChats')}
          aria-label={t('claudeChats')}
          value={current ?? ''}
          disabled={!options.length}
          onFocus={() => void listChats().then(setChats)}
          onChange={(e) => setWant({ id: e.target.value })}
        >
          {options.map((c) => (
            <option key={c.id} value={c.id}>
              {(c.title || t('claudeNewChat')) + (c.updated ? ` · ${fmt(c.updated)}` : '')}
            </option>
          ))}
        </select>
        <button
          className="claude-new"
          title={t('claudeNewChat')}
          aria-label={t('claudeNewChat')}
          onClick={() => setWant({ id: null })}
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          className="claude-close"
          title={t('claudeClose')}
          aria-label={t('claudeClose')}
          onClick={onClose}
        >
          <Icon name="close" size={15} />
        </button>
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
