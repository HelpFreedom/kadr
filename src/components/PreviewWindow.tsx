import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '@/i18n'
import { Preview } from './Preview'
import { TransportBar } from './TransportBar'

const WINDOW_NAME = 'kadr-preview'
const BOUNDS_KEY = 'kadr.previewWindowBounds'

interface PreviewBounds {
  x?: number
  y?: number
  width: number
  height: number
}

function savedBounds(): PreviewBounds {
  const fallback = { width: 960, height: 540 }
  try {
    const value = JSON.parse(localStorage.getItem(BOUNDS_KEY) ?? '') as Partial<PreviewBounds>
    return {
      x: Number.isFinite(value.x) ? value.x : undefined,
      y: Number.isFinite(value.y) ? value.y : undefined,
      width: Number.isFinite(value.width) ? Math.max(480, value.width!) : fallback.width,
      height: Number.isFinite(value.height) ? Math.max(320, value.height!) : fallback.height
    }
  } catch {
    return fallback
  }
}

function rememberBounds(popup: Window) {
  if (popup.closed) return
  const bounds: PreviewBounds = {
    x: popup.screenX,
    y: popup.screenY,
    width: popup.outerWidth,
    height: popup.outerHeight
  }
  localStorage.setItem(BOUNDS_KEY, JSON.stringify(bounds))
}

function copyStyles(target: Document) {
  const base = target.createElement('base')
  base.href = document.baseURI
  target.head.appendChild(base)

  document.head.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((source) => {
    const link = target.createElement('link')
    link.rel = 'stylesheet'
    link.href = source.href
    target.head.appendChild(link)
  })
  document.head.querySelectorAll<HTMLStyleElement>('style').forEach((source) => {
    target.head.appendChild(source.cloneNode(true))
  })
}

function preparePopup(popup: Window, title: string) {
  const doc = popup.document
  doc.documentElement.lang = document.documentElement.lang
  doc.title = title
  doc.head.replaceChildren()
  doc.body.replaceChildren()
  copyStyles(doc)
  doc.body.className = 'detached-preview-body'
  const root = doc.createElement('div')
  root.className = 'detached-preview-root'
  doc.body.appendChild(root)
  return root
}

export function PreviewWindow({
  onKeyDown,
  onDetachedChange
}: {
  onKeyDown: (e: KeyboardEvent) => void
  onDetachedChange: (detached: boolean) => void
}) {
  const t = useT()
  const popupRef = useRef<Window | null>(null)
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null)

  const dock = useCallback(() => {
    const popup = popupRef.current
    if (!popup) {
      setPortalRoot(null)
      return
    }
    rememberBounds(popup)
    popupRef.current = null
    setPortalRoot(null)
    // Let React move the portal back before Chromium destroys its document.
    window.setTimeout(() => {
      if (!popup.closed) popup.close()
    }, 0)
  }, [])

  const detach = useCallback(() => {
    const current = popupRef.current
    if (current && !current.closed) {
      current.focus()
      return
    }

    const bounds = savedBounds()
    const position = bounds.x === undefined || bounds.y === undefined
      ? ''
      : `,left=${Math.round(bounds.x)},top=${Math.round(bounds.y)}`
    const popup = window.open(
      'about:blank',
      WINDOW_NAME,
      `popup=yes,width=${Math.round(bounds.width)},height=${Math.round(bounds.height)}${position}`
    )
    if (!popup) return

    const root = preparePopup(popup, t('previewWindowTitle'))
    popupRef.current = popup
    popup.addEventListener('keydown', onKeyDown)
    popup.addEventListener('beforeunload', () => {
      rememberBounds(popup)
      if (popupRef.current === popup) popupRef.current = null
      setPortalRoot(null)
    }, { once: true })
    setPortalRoot(root)
    popup.focus()
  }, [onKeyDown, t])

  useEffect(() => {
    const popup = popupRef.current
    if (popup && !popup.closed) popup.document.title = t('previewWindowTitle')
  }, [portalRoot, t])

  useEffect(() => {
    onDetachedChange(Boolean(portalRoot))
  }, [onDetachedChange, portalRoot])

  useEffect(() => () => {
    const popup = popupRef.current
    if (popup && !popup.closed) popup.close()
  }, [])

  const pane = (
    <div className={portalRoot ? 'preview-host detached' : 'preview-host'}>
      <Preview />
      <TransportBar
        previewDetached={Boolean(portalRoot)}
        onPreviewToggle={portalRoot ? dock : detach}
      />
    </div>
  )

  return (
    <>
      {!portalRoot && pane}
      {portalRoot && createPortal(pane, portalRoot)}
    </>
  )
}
