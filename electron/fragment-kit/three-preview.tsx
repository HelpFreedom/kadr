// Kadr preview wrapper for @remotion/three. Managed by Kadr — do not edit.
//
// Only the PREVIEW sees this file (vite.config.ts redirects '@remotion/three'
// here for every module but this one); `remotion render` uses the real
// package, so exports are untouched by it. Two things differ in the preview:
//
// * The fragment iframe draws only when there is something new to draw.
//   r3f's default loop renders on every animation frame, forever: measured
//   ~100 full 1080p renders a second per iframe, in the visible one AND in the
//   hidden one parked on its first frame for the next cut, paused or not. Here
//   the loop is 'demand' and a frame change asks for one render — from inside
//   the Canvas, in a layout effect, i.e. after the inner r3f tree committed:
//   fragment code that moves the camera or edits materials in its render body
//   (common, and fine for remotion) is then already applied when it draws.
//   A couple of late requests follow a change for what settles on its own
//   time (a video texture's next frame, a loaded font); during playback the
//   next frame cancels them before they fire. Pixel-capture windows (they
//   feed snapshots) keep the 'always' loop.
// * It renders at the size it is SHOWN. The iframe shows a 1920×1080 canvas
//   at ~740 px; drawing it at full size is ~7× the pixels nobody sees. The
//   editor tells the page its display scale; dpr follows (never above what
//   the fragment itself asked for).
import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useThree, useFrame, addAfterEffect } from '@react-three/fiber'
import { useCurrentFrame } from 'remotion'
import { ThreeCanvas as RemotionThreeCanvas } from '@remotion/three'
import { subscribeParams, paramsVersion } from './runtime'

export * from '@remotion/three'

type Rec = { pending: number; drawn: number }
const K = window as any
const view = (): { demand: boolean; scale: number } => K.__kadrPreview ?? { demand: false, scale: 1 }
const canvases: Set<Rec> = (K.__kadrCanvases ??= new Set<Rec>())

// the frame every mounted canvas has actually drawn (snapshots wait for it)
addAfterEffect(() => {
  let min = Infinity
  for (const r of canvases) {
    if (r.pending >= 0) r.drawn = r.pending
    min = Math.min(min, r.drawn)
  }
  K.__kadrGlDrawn = canvases.size ? min : undefined
})

function Driver({ rec }: { rec: Rec }) {
  const frame = useCurrentFrame()
  const invalidate = useThree((s) => s.invalidate)
  // a parameter dragged in the Inspector changes the picture on the SAME frame
  const pv = useSyncExternalStore(subscribeParams, paramsVersion, paramsVersion)
  const cur = useRef(frame)
  cur.current = frame
  useFrame(() => { rec.pending = cur.current })
  useLayoutEffect(() => {
    invalidate()
    const late = [120, 400].map((ms) => setTimeout(() => invalidate(), ms))
    return () => late.forEach(clearTimeout)
  }, [frame, pv, invalidate])
  return null
}

const dprOf = (d: unknown): number => {
  const dev = window.devicePixelRatio || 1
  if (typeof d === 'number') return d
  if (Array.isArray(d)) return Math.min(Math.max(dev, Number(d[0]) || 1), Number(d[1]) || 2)
  return Math.min(Math.max(dev, 1), 2) // r3f's default [1, 2]
}

export const ThreeCanvas: typeof RemotionThreeCanvas = (props: any) => {
  const [v, setV] = useState(view)
  useEffect(() => {
    const on = () => setV(view())
    window.addEventListener('kadr-view', on)
    return () => window.removeEventListener('kadr-view', on)
  }, [])
  const [rec] = useState<Rec>(() => ({ pending: -1, drawn: -1 }))
  useEffect(() => {
    canvases.add(rec)
    return () => { canvases.delete(rec) }
  }, [rec])
  const own = dprOf(props.dpr)
  const dpr = v.scale < 1 ? Math.max(0.25, Math.min(own, v.scale * (window.devicePixelRatio || 1))) : props.dpr
  const frameloop = v.demand && !props.frameloop ? 'demand' : props.frameloop
  return (
    <RemotionThreeCanvas {...props} dpr={dpr} frameloop={frameloop}>
      {props.children}
      <Driver rec={rec} />
    </RemotionThreeCanvas>
  )
}
