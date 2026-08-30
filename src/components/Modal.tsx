import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './icons'
import { useT } from '@/i18n'

/**
 * How many dialogs are open right now.
 *
 * App.tsx reads it before acting on a global shortcut: the window-level
 * handler only ignored INPUT/TEXTAREA/SELECT, so Space on a focused dialog
 * button both pressed the button AND started playback behind the dialog, and
 * `D` deleted the selected clip while the export dialog was open.
 */
let openCount = 0
export const modalsOpen = () => openCount > 0

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled),' +
  ' textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * The shell every dialog in the editor shares: a titled head with a close
 * control, a scrolling body, and a footer that stays in place while the body
 * scrolls. It is also the accessibility floor — role, label, Escape, a focus
 * trap and focus restored to wherever it came from — which none of the eight
 * dialogs had on their own.
 */
export function Modal({
  title, onClose, children, actions, className, wide, closeDisabled, titleIcon
}: {
  title: string
  onClose: () => void
  children: ReactNode
  actions?: ReactNode
  className?: string
  wide?: boolean
  /** true while an operation must not be interrupted (an export in flight) */
  closeDisabled?: boolean
  titleIcon?: ReactNode
}) {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const titleId = useRef(`m${Math.random().toString(36).slice(2, 9)}`)

  useEffect(() => {
    openCount++
    const restoreTo = document.activeElement as HTMLElement | null
    // focus the first control INSIDE the body: landing on the close button
    // reads as "the only thing here is a way out". A dialog that is pure text
    // falls back to the box itself, which is what Escape listens on.
    const first = box.current?.querySelector<HTMLElement>('.modal-body ' + FOCUSABLE.split(', ').join(', .modal-body '))
    ;(first ?? box.current)?.focus()
    return () => {
      openCount--
      restoreTo?.focus?.()
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      if (!closeDisabled) onClose()
      return
    }
    if (e.key !== 'Tab') return
    // trap: Tab must not walk out into the editor behind the dialog
    const items = [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])]
      .filter((el) => el.offsetParent !== null)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === box.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className="modal-back"
      onClick={() => { if (!closeDisabled) onClose() }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={box}
        className={`modal${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId.current}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          {titleIcon}
          <h2 id={titleId.current}>{title}</h2>
          <button
            className="modal-close"
            title={t('close')}
            aria-label={t('close')}
            disabled={closeDisabled}
            onClick={onClose}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {actions && <div className="modal-foot"><div className="modal-actions">{actions}</div></div>}
      </div>
    </div>
  )
}
