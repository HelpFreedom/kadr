// The eyedropper: the next click on the preview gives the colour under it to
// an effect's colour param (a chroma key's key colour). While it waits, that
// effect is bypassed in the preview, so the pick sees the unkeyed picture.
// Esc or a click anywhere else cancels.
import { create } from 'zustand'
import { previewCanvasEl, redrawPreview } from './snapshot'

export interface PickTarget {
  clipId: string
  effectId: string
  param: string
}

export const useEyedropper = create<{ target: PickTarget | null }>(() => ({ target: null }))

const hex2 = (v: number) => v.toString(16).padStart(2, '0')

/** The colour of the preview canvas under a client point, or null outside it. */
export function previewColorAt(clientX: number, clientY: number): string | null {
  const canvas = previewCanvasEl()
  if (!canvas) return null
  const r = canvas.getBoundingClientRect()
  if (clientX < r.left || clientX >= r.right || clientY < r.top || clientY >= r.bottom) return null
  const x = Math.floor(((clientX - r.left) / r.width) * canvas.width)
  const y = Math.floor(((clientY - r.top) / r.height) * canvas.height)
  // the GL canvas keeps its buffer (preserveDrawingBuffer), so a 2D copy of
  // one pixel reads what is on screen
  const probe = canvas.ownerDocument.createElement('canvas')
  probe.width = probe.height = 1
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1)
  const [pr, pg, pb] = ctx.getImageData(0, 0, 1, 1).data
  return `#${hex2(pr)}${hex2(pg)}${hex2(pb)}`
}

let stop: (() => void) | null = null

export function cancelEyedropper() {
  stop?.()
}

export function startEyedropper(target: PickTarget, onPick: (hex: string) => void) {
  cancelEyedropper()
  const canvas = previewCanvasEl()
  if (!canvas) return
  // the preview may live in a popped-out window: listen where the canvas is
  const doc = canvas.ownerDocument
  const docs = doc === document ? [document] : [document, doc]
  const onDown = (e: PointerEvent) => {
    const hex = e.target === previewCanvasEl() ? previewColorAt(e.clientX, e.clientY) : null
    if (hex) {
      e.preventDefault()
      e.stopPropagation()
    }
    done()
    if (hex) onPick(hex)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    done()
  }
  const done = () => {
    for (const d of docs) {
      d.removeEventListener('pointerdown', onDown, true)
      d.removeEventListener('keydown', onKey, true)
      d.body.classList.remove('fx-picking')
    }
    stop = null
    useEyedropper.setState({ target: null })
    redrawPreview()
  }
  for (const d of docs) {
    d.addEventListener('pointerdown', onDown, true)
    d.addEventListener('keydown', onKey, true)
    d.body.classList.add('fx-picking')
  }
  stop = done
  useEyedropper.setState({ target })
  redrawPreview()
}
