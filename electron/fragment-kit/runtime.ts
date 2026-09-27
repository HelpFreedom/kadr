// Kadr runtime for fragments: import from '@kadr/runtime'. Managed by Kadr —
// do not edit (it is rewritten when Kadr updates).
//
// FONTS are registered here, at module level, never by a component: a font
// loader inside a component loses its font when the component unmounts, and
// a delayRender() in a render React throws away is never continued — both
// were met in real fragments. Files in the project's kadr-lib/fonts/ are
// registered by Kadr itself (preview page and render entry); loadFont() is
// for anything else.
import { useMemo, useSyncExternalStore } from 'react'
import { delayRender, continueRender } from 'remotion'

const registered = new Set<string>()

/** Register a font face for the whole page; the render waits until it loads. */
export function loadFont(url: string, family: string, descriptors: FontFaceDescriptors = {}): void {
  const key = `${family}|${url}|${JSON.stringify(descriptors)}`
  if (registered.has(key) || typeof document === 'undefined') return
  registered.add(key)
  const face = new FontFace(family, `url(${url})`, { display: 'block', ...descriptors })
  document.fonts.add(face)
  const h = delayRender(`font ${family}`, { timeoutInMilliseconds: 20000 })
  face.load().then(
    () => continueRender(h),
    (e) => { console.error(`[kadr] font ${family} (${url}) failed to load: ${e}`); continueRender(h) }
  )
}

/**
 * Family and descriptors from a font FILE name, the kadr-lib/fonts
 * convention: "Inter.woff2" → Inter (any weight — variable fonts),
 * "Inter-700.woff2" → Inter 700, "Inter-400-italic.ttf" → Inter 400 italic.
 */
export function fontFromFileName(file: string): [string, FontFaceDescriptors] {
  const base = file.replace(/\.[^.]+$/, '')
  const m = base.match(/^(.+?)(?:[-_ ](\d{3}))?(?:[-_ ](italic))?$/i)
  const family = m?.[1] ?? base
  const desc: FontFaceDescriptors = { weight: m?.[2] ?? '100 900' }
  if (m?.[3]) desc.style = 'italic'
  return [family, desc]
}

// --------------------------------------------------------------- checks
//
// What a fragment DECLARES about itself so Kadr can check it against the
// music and the rules of readable motion (kadr_check, «Проверка»). Export it
// with the fragment: `export const fragment = { component, meta, inspect }`.
// Nothing here changes a pixel of the render — Kadr reads it in a separate,
// hidden page. All times are COMPOSITION seconds; positions are composition
// pixels (0,0 = top left).

export interface KadrEvent {
  t: number
  /** 'big': a scene change, a part landing, a reveal — belongs on the "one" of
      a bar; 'small': a click, a turn, a layer — on any beat */
  kind: 'big' | 'small'
  label?: string
}

export interface KadrText {
  /** fully visible from … to (after its entrance, before its exit) */
  from: number
  to: number
  text: string
  sub?: string
  /** 'title' is the one main caption at a time; 'note' and 'caption' may coexist with it */
  role?: 'title' | 'note' | 'caption'
  /** where it sits, [x, y, w, h] — for overlaps and the contrast check */
  box?: [number, number, number, number]
  /** its colour, for the contrast check (CSS colour) */
  color?: string
  /** its position over time [x, y] if it moves — readable text should not */
  at?: (t: number) => [number, number]
}

export interface KadrCameraState {
  pos: [number, number, number]
  target: [number, number, number]
  fov?: number
}

export interface KadrInspect {
  events?: KadrEvent[]
  texts?: KadrText[]
  /** the camera as a function of time — checked for jerks */
  camera?: (t: number) => KadrCameraState
  /** this fragment is a window of one continuous film: its cuts against the
      neighbouring window of the same film must be invisible (seam check) */
  continuous?: boolean
}

/** Identity — for types: `export const inspect = defineInspect({ … })`. */
export const defineInspect = (i: KadrInspect): KadrInspect => i

// ------------------------------------------------------------ parameters
//
// Numbers (and colours, switches) a fragment exposes to the editor: the
// Inspector of a selected fragment clip shows them as sliders, the preview
// follows a slider LIVE (no reload, no rebuild), and the value is saved into
// the fragment's own params.json — which the render reads too, so what was
// dialled in is what exports. Made for what is tuned by eye: the angle that
// lines a 3D camera up with filmed footage, a delay, a size, a colour.
//
//   const P = defineParams({
//     az:    { value: -35, min: -180, max: 180, step: 1, label: 'Азимут' },
//     glow:  { value: '#9c7ad8', label: 'Подсветка' },
//     edges: { value: true, label: 'Рёбра' }
//   })
//   const Film = () => { const p = useParams(P); … p.az … }
//
// Declare at MODULE level (Kadr reads the declarations without rendering);
// readParams(P) gives the same values outside React — e.g. in inspect.camera.
// Read values at RENDER time (useParams, or readParams inside a function):
// params.json arrives after the module has been evaluated, so a constant
// computed from readParams at module level would keep the default.
// Precedence: a value being dragged → params.json → the declared default.

export type KadrParamDecl =
  | { value: number; min?: number; max?: number; step?: number; label?: string }
  | { value: boolean; label?: string }
  | { value: string; label?: string }

export type KadrParamValue = number | boolean | string

// widened: a declared `value: 30` is inferred as the literal 30
type Widen<V> = V extends number ? number : V extends boolean ? boolean : string
type ParamValues<T extends Record<string, KadrParamDecl>> = { [K in keyof T]: Widen<T[K]['value']> }

interface ParamStore {
  saved: Record<string, unknown>
  live: Record<string, unknown>
  decl: Record<string, KadrParamDecl>
  version: number
  subs: Set<() => void>
}

// on the page's global: the render entry, the player page and the fragment may
// each reach this file through a different module id
const store = (): ParamStore =>
  ((globalThis as any).__kadrParams ??= { saved: {}, live: {}, decl: {}, version: 0, subs: new Set() })

/** Kadr's side: 'saved' = the params.json the page loaded, 'live' = values being dragged. */
export function setParamValues(kind: 'saved' | 'live', values: Record<string, unknown> | null | undefined): void {
  const s = store()
  const next = values && typeof values === 'object' && !Array.isArray(values) ? { ...values } : {}
  if (JSON.stringify(next) === JSON.stringify(s[kind])) return // a repeat: nothing to redraw
  s[kind] = next
  s.version++
  for (const f of [...s.subs]) f()
}

export const subscribeParams = (f: () => void): (() => void) => {
  const s = store()
  s.subs.add(f)
  return () => { s.subs.delete(f) }
}
export const paramsVersion = (): number => store().version
/** every declaration seen on this page (Kadr's inspect page reads it) */
export const paramDeclarations = (): Record<string, KadrParamDecl> => ({ ...store().decl })

const valid = (d: KadrParamDecl, v: unknown): boolean =>
  typeof v === typeof d.value && (typeof v !== 'number' || Number.isFinite(v))

export function defineParams<T extends Record<string, KadrParamDecl>>(decl: T): T {
  Object.assign(store().decl, decl)
  return decl
}

export function readParams<T extends Record<string, KadrParamDecl>>(p: T): ParamValues<T> {
  const s = store()
  const out = {} as ParamValues<T>
  for (const k of Object.keys(p) as (keyof T & string)[]) {
    const d = p[k]
    const v = valid(d, s.live[k]) ? s.live[k] : valid(d, s.saved[k]) ? s.saved[k] : d.value
    ;(out as any)[k] = v
  }
  return out
}

/** The current values; the component re-renders when one changes. */
export function useParams<T extends Record<string, KadrParamDecl>>(p: T): ParamValues<T> {
  const v = useSyncExternalStore(subscribeParams, paramsVersion, paramsVersion)
  return useMemo(() => readParams(p), [p, v])
}
