import { useLayoutEffect, useRef, useState } from 'react'

/** Context menu container that stays fully inside the viewport. */
export function CtxMenu({
  x, y, className, children
}: {
  x: number
  y: number
  className?: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y, visibility: 'hidden' as const })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const clamp = () => {
      const r = el.getBoundingClientRect()
      setPos({
        left: Math.max(4, Math.min(x, window.innerWidth - r.width - 8)),
        top: Math.max(4, Math.min(y, window.innerHeight - r.height - 8)),
        visibility: 'visible' as never
      })
    }
    clamp()
    // items may appear while open (e.g. the remove row) — keep it on screen
    const ro = new ResizeObserver(clamp)
    ro.observe(el)
    return () => ro.disconnect()
  }, [x, y])
  return (
    <div
      ref={ref}
      className={`ctx-menu ${className ?? ''}`}
      style={pos}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  )
}
