import type { Clip, MediaAsset, Project, TextStyle, Track } from '@shared/types'
import { evalAnim } from './anim'
import { fadeFactor, videoLayersAt } from './player'

export interface TextContentBounds {
  width: number
  height: number
  centerX: number
}

export function measureTextContent(
  text: string,
  style: TextStyle,
  projectWidth: number
): TextContentBounds {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${style.fontSize}px ${style.fontFamily}`
  const lines = (text || ' ').split('\n')
  const rawWidth = Math.max(...lines.map((line) => ctx.measureText(line || ' ').width))
  const pad = style.background ? style.fontSize * 0.4 : style.outlineWidth + 4
  const width = Math.max(style.fontSize, rawWidth + pad * 2)
  const height = Math.max(style.fontSize, style.fontSize * 1.25 * lines.length + pad * 2)
  const anchor = style.align === 'left'
    ? projectWidth * 0.1
    : style.align === 'right'
      ? projectWidth * 0.9
      : projectWidth / 2
  const centerX = style.align === 'left'
    ? anchor + rawWidth / 2
    : style.align === 'right'
      ? anchor - rawWidth / 2
      : anchor
  return { width, height, centerX }
}

function inverse2d(
  px: number,
  py: number,
  x: number,
  y: number,
  scale: number,
  rotation: number
): [number, number] {
  const dx = px - x
  const dy = py - y
  const rad = rotation * Math.PI / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const safeScale = Math.max(0.0001, Math.abs(scale))
  return [
    (dx * cos + dy * sin) / safeScale,
    (-dx * sin + dy * cos) / safeScale
  ]
}

function sourceSize(
  project: Project,
  clip: Clip,
  asset: MediaAsset | undefined
): { width: number; height: number; fit: number } | null {
  if (clip.kind === 'text') return { width: project.width, height: project.height, fit: 1 }
  if (clip.kind === 'remotion') {
    const width = clip.fragmentMeta?.width ?? project.width
    const height = clip.fragmentMeta?.height ?? project.height
    return { width, height, fit: Math.min(project.width / width, project.height / height) }
  }
  if (!asset || asset.kind === 'audio') return null
  const width = Math.max(1, asset.width || project.width)
  const height = Math.max(1, asset.height || project.height)
  return { width, height, fit: Math.min(project.width / width, project.height / height) }
}

function hitsLayer(
  project: Project,
  playhead: number,
  projectX: number,
  projectY: number,
  clip: Clip,
  track: Track,
  asset: MediaAsset | undefined
): boolean {
  const rel = Math.max(0, Math.min(clip.duration, playhead - clip.start))
  const opacity = evalAnim(clip.transform.opacity, rel) * fadeFactor(clip, rel) * track.gain
  if (opacity <= 0.01) return false
  const source = sourceSize(project, clip, asset)
  if (!source) return false

  let x = projectX - project.width / 2
  let y = projectY - project.height / 2
  if (track.motion) {
    ;[x, y] = inverse2d(
      x,
      y,
      evalAnim(track.motion.x, playhead),
      evalAnim(track.motion.y, playhead),
      evalAnim(track.motion.scale, playhead),
      evalAnim(track.motion.rotation, playhead)
    )
  }
  ;[x, y] = inverse2d(
    x,
    y,
    evalAnim(clip.transform.x, rel),
    evalAnim(clip.transform.y, rel),
    evalAnim(clip.transform.scale, rel) * source.fit,
    evalAnim(clip.transform.rotation, rel)
  )

  if (clip.kind === 'text' && clip.textStyle) {
    const bounds = measureTextContent(clip.text ?? '', clip.textStyle, project.width)
    const centerX = bounds.centerX - project.width / 2
    return Math.abs(x - centerX) <= bounds.width / 2 && Math.abs(y) <= bounds.height / 2
  }

  if (Math.abs(x) > source.width / 2 || Math.abs(y) > source.height / 2) return false
  if (clip.mask) {
    const u = x / source.width + 0.5
    const v = y / source.height + 0.5
    const left = Math.min(0.5, Math.max(0, evalAnim(clip.mask.left, rel)))
    const top = Math.min(0.5, Math.max(0, evalAnim(clip.mask.top, rel)))
    const right = Math.min(0.5, Math.max(0, evalAnim(clip.mask.right, rel)))
    const bottom = Math.min(0.5, Math.max(0, evalAnim(clip.mask.bottom, rel)))
    if (u < left || u > 1 - right || v < top || v > 1 - bottom) return false
  }
  return true
}

/** Visible visual clips under a project-space point, topmost first. */
export function previewHitsAt(
  project: Project,
  playhead: number,
  projectX: number,
  projectY: number
): Clip[] {
  return videoLayersAt(project, playhead)
    .slice()
    .reverse()
    .filter(({ clip, track, asset }) =>
      hitsLayer(project, playhead, projectX, projectY, clip, track, asset)
    )
    .map(({ clip }) => clip)
}
