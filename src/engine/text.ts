import type { TextStyle } from '@shared/types'

export interface TextLayer {
  canvas: HTMLCanvasElement
  /** changes whenever text/style changes, used as texture cache key */
  hash: string
}

const cache = new Map<string, TextLayer>()

export function textHash(text: string, style: TextStyle): string {
  return JSON.stringify([text, style])
}

/** Render text into a project-sized canvas (centered), cached by content. */
export function getTextLayer(
  clipId: string,
  text: string,
  style: TextStyle,
  width: number,
  height: number
): TextLayer {
  const hash = textHash(text, style) + `@${width}x${height}`
  const cached = cache.get(clipId)
  if (cached && cached.hash === hash) return cached

  const canvas = cached?.canvas ?? document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, width, height)

  const font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize}px ${style.fontFamily}`
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.textAlign = style.align
  const lines = text.split('\n')
  const lineH = style.fontSize * 1.25
  const totalH = lineH * lines.length
  const x = style.align === 'left' ? width * 0.1 : style.align === 'right' ? width * 0.9 : width / 2

  if (style.background) {
    let maxW = 0
    for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width)
    const pad = style.fontSize * 0.4
    const bx =
      style.align === 'left' ? x - pad : style.align === 'right' ? x - maxW - pad : x - maxW / 2 - pad
    ctx.fillStyle = style.background
    ctx.fillRect(bx, height / 2 - totalH / 2 - pad, maxW + pad * 2, totalH + pad * 2)
  }

  lines.forEach((line, i) => {
    const y = height / 2 - totalH / 2 + lineH * (i + 0.5)
    if (style.outlineWidth > 0) {
      ctx.lineWidth = style.outlineWidth
      ctx.strokeStyle = style.outlineColor
      ctx.lineJoin = 'round'
      ctx.strokeText(line, x, y)
    }
    ctx.fillStyle = style.color
    ctx.fillText(line, x, y)
  })

  const layer: TextLayer = { canvas, hash }
  cache.set(clipId, layer)
  return layer
}
