import { useEffect, useRef, useState } from 'react'
import { useLog, clearLog, logAsText, logTime, markLogSeen, type LogEntry } from '@/engine/log'
import { useT } from '@/i18n'
import { Icon } from './icons'

function Row({ e }: { e: LogEntry }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`log-row ${e.level}`}>
      <button
        className="log-line"
        disabled={!e.detail}
        title={e.detail ? undefined : e.msg}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="log-time">{logTime(e.t)}</span>
        <Icon
          name={e.level === 'error' ? 'alert' : e.level === 'warn' ? 'alert' : 'check'}
          size={12}
          className="log-mark"
        />
        <span className="log-source">{e.source}</span>
        <span className="log-msg">{e.msg}</span>
        {e.detail && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} className="log-more" />}
      </button>
      {open && e.detail && <pre className="log-detail">{e.detail}</pre>}
    </div>
  )
}

/**
 * The session's log, on screen. Deliberately a plain list with no filters and
 * no persistence: it only ever holds things that went wrong, it is short, and
 * it disappears with the window.
 */
export function DebugPanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  const entries = useLog((s) => s.entries)
  const body = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [copied, setCopied] = useState(false)

  useEffect(() => { markLogSeen() }, [entries.length])

  // follow the tail, but only while the reader is already at the bottom —
  // scrolling up to read something must not be undone by the next entry
  useEffect(() => {
    const el = body.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries.length])

  return (
    <div className="debug-panel">
      <div className="claude-head debug-head">
        <span><Icon name="terminal" size={15} /> {t('logTitle')}</span>
        <span className="dim claude-hint">
          {entries.length ? `${t('logEntries')}: ${entries.length}` : t('logHint')}
        </span>
        <button
          className="icon-only"
          title={t('logCopy')}
          aria-label={t('logCopy')}
          disabled={!entries.length}
          onClick={() => {
            void navigator.clipboard.writeText(logAsText()).then(
              () => { setCopied(true); setTimeout(() => setCopied(false), 1500) },
              () => { /* clipboard refused — nothing to report to itself */ }
            )
          }}
        >
          <Icon name={copied ? 'check' : 'doc'} size={14} />
        </button>
        <button
          className="icon-only"
          title={t('logClear')}
          aria-label={t('logClear')}
          disabled={!entries.length}
          onClick={clearLog}
        >
          <Icon name="trash" size={14} />
        </button>
        <button className="claude-close" title={t('close')} aria-label={t('close')} onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>
      <div
        className="log-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {entries.length === 0
          ? <div className="hint">{t('logEmpty')}</div>
          : entries.map((e) => <Row key={e.id} e={e} />)}
      </div>
    </div>
  )
}
