// The preview in its own OS window.
//
// What is moved matters more than where to. The picture is a live WebGL2
// canvas with Remotion iframes positioned over it, so it must not be built a
// second time on the far side: a new canvas means a new GL context (Chromium
// keeps 16 per renderer and force-loses the OLDEST beyond that — the very
// trap Compositor.dispose exists for), and every fragment iframe would
// reload on each toggle.
//
// So nothing is re-created. The preview always lives in ONE host div that a
// React portal renders into, and popping out only moves that div into the
// popup's document. React attaches its event listeners to the portal
// container itself, so they travel with the div; the canvas keeps the very
// same GL context; the Player never detaches. `window.open` gives a real
// BrowserWindow — resizable, movable, and free to sit on another monitor.
//
// The popup is `about:blank`, i.e. same-origin with the editor and in the
// same renderer process: without that the DOM could not be adopted at all.
import { create } from 'zustand'
import { tr } from '@/i18n'
import { logWarn } from './log'

const WIN_NAME = 'kadr-preview'
const GEOM_KEY = 'kadr.previewWindow'
const DEF_W = 960
const DEF_H = 560
const MIN_W = 320
const MIN_H = 200

/** null = the preview is docked in the editor. */
export const usePopout = create<{ win: Window | null }>(() => ({ win: null }))

/** The one element the preview ever lives in; only its parent changes. */
export const previewHost: HTMLDivElement = (() => {
  const el = document.createElement('div')
  el.className = 'preview-host'
  return el
})()

let slot: HTMLElement | null = null
let stopStyles: (() => void) | null = null
let leave: (() => void) | null = null
let watchdog = 0

/** App.tsx hands over the place the preview sits in when docked. */
export function setPreviewSlot(el: HTMLElement | null): void {
  slot = el
  if (el && !usePopout.getState().win && previewHost.parentElement !== el) el.appendChild(previewHost)
}

interface Geom { w: number; h: number; x?: number; y?: number }

function readGeom(): Geom {
  try {
    const raw = localStorage.getItem(GEOM_KEY)
    if (raw) {
      const g = JSON.parse(raw) as Geom
      if (Number.isFinite(g.w) && Number.isFinite(g.h) && g.w >= MIN_W && g.h >= MIN_H) return g
    }
  } catch { /* a corrupt entry must not cost the button */ }
  return { w: DEF_W, h: DEF_H }
}

/** Read while the window is ALIVE — a closed one reports zeros. */
function saveGeom(w: Window): void {
  try {
    const g: Geom = {
      w: Math.round(w.outerWidth), h: Math.round(w.outerHeight),
      x: Math.round(w.screenX), y: Math.round(w.screenY)
    }
    if (g.w >= MIN_W && g.h >= MIN_H) localStorage.setItem(GEOM_KEY, JSON.stringify(g))
  } catch { /* geometry is a convenience, never a failure */ }
}

/**
 * The popup carries no stylesheet of its own: every style and stylesheet link
 * of the editor is cloned into it, and re-cloned when they change — a CSS edit
 * in dev arrives as a mutation of the injected <style>, and without this the
 * detached preview would keep the styles it was born with. New nodes are
 * appended BEFORE the old ones go, so a resync never flashes unstyled.
 */
function mirrorStyles(doc: Document): () => void {
  const sync = () => {
    const old = Array.from(doc.head.querySelectorAll('[data-kadr-style]'))
    for (const node of Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))) {
      const clone = doc.importNode(node, true) as HTMLElement
      // href is relative to the editor's document; about:blank would resolve
      // it against itself and silently load nothing
      if (node instanceof HTMLLinkElement) clone.setAttribute('href', node.href)
      clone.setAttribute('data-kadr-style', '')
      doc.head.appendChild(clone)
    }
    for (const node of old) node.remove()
  }
  sync()
  let timer = 0
  const obs = new MutationObserver(() => {
    clearTimeout(timer)
    timer = window.setTimeout(sync, 30)
  })
  obs.observe(document.head, { childList: true, subtree: true, characterData: true })
  return () => { obs.disconnect(); clearTimeout(timer) }
}

/** The editor going away (a reload, a quit) must not leave the popup behind. */
function closeOnMainUnload(): void {
  const w = usePopout.getState().win
  if (w && !w.closed) {
    saveGeom(w)
    try { w.close() } catch { /* already gone */ }
  }
}

export function openPreviewWindow(): boolean {
  if (usePopout.getState().win) return true
  const g = readGeom()
  const feat = `width=${g.w},height=${g.h},resizable=yes` +
    (g.x !== undefined && g.y !== undefined ? `,left=${g.x},top=${g.y}` : '')
  let w: Window | null = null
  try {
    w = window.open('', WIN_NAME, feat)
  } catch (err) {
    logWarn('превью', 'отдельное окно предпросмотра не открылось', err)
    return false
  }
  if (!w) {
    logWarn('превью', 'отдельное окно предпросмотра не открылось')
    return false
  }
  const doc = w.document
  // about:blank normally arrives with a body; write one when it does not
  if (!doc.body) {
    doc.write('<!doctype html><html><head></head><body></body></html>')
    doc.close()
  }
  doc.documentElement.lang = document.documentElement.lang || 'ru'
  doc.title = tr('popoutTitle')
  doc.body.className = 'kadr-popout'
  stopStyles = mirrorStyles(doc)
  doc.body.appendChild(previewHost)

  const win = w
  leave = () => {
    // still alive here, so the geometry is readable and the host can be
    // carried out before this document (and the canvas in it) is destroyed
    saveGeom(win)
    dock(true)
  }
  win.addEventListener('beforeunload', leave)
  win.addEventListener('pagehide', leave)
  window.addEventListener('beforeunload', closeOnMainUnload)
  // backstop: a window destroyed without unloading (a hard kill) would
  // otherwise leave the button stuck in the "detached" state forever
  watchdog = window.setInterval(() => {
    if (win.closed) dock(true)
  }, 1000)
  usePopout.setState({ win })
  try { win.focus() } catch { /* the WM decides */ }
  return true
}

export function dockPreviewWindow(): void {
  dock(false)
}

function dock(closing: boolean): void {
  const w = usePopout.getState().win
  if (watchdog) { clearInterval(watchdog); watchdog = 0 }
  window.removeEventListener('beforeunload', closeOnMainUnload)
  if (w && leave) {
    w.removeEventListener('beforeunload', leave)
    w.removeEventListener('pagehide', leave)
  }
  leave = null
  stopStyles?.()
  stopStyles = null
  // the host has to leave the popup's document while that document is still
  // alive: the canvas, its GL context and the fragment iframes go with it
  ;(slot ?? document.body).appendChild(previewHost)
  usePopout.setState({ win: null })
  if (w && !closing && !w.closed) {
    saveGeom(w)
    try { w.close() } catch { /* already gone */ }
  }
}

export function togglePreviewWindow(): boolean {
  if (usePopout.getState().win) { dockPreviewWindow(); return false }
  return openPreviewWindow()
}
