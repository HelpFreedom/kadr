import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useEditor } from '@/state/store'
import { activity } from '@/engine/autosave'
import { useT } from '@/i18n'

/**
 * Embedded Claude Code session: an xterm terminal driven by a PTY in the
 * main process running the user's `claude` CLI, with the kadr MCP server
 * wired to this very editor instance. Closing the panel kills the session.
 */
export function ClaudePanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  const holder = useRef<HTMLDivElement>(null)

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
    const cwd = projectPath ? projectPath.replace(/\/[^/]*$/, '') : null
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
    <div className="claude-panel">
      <div className="claude-head">
        <span>🤖 Claude Code</span>
        <span className="dim claude-hint">{t('claudeHint')}</span>
        <button className="claude-close" title={t('claudeClose')} onClick={onClose}>✕</button>
      </div>
      <div className="claude-term" ref={holder} />
    </div>
  )
}
