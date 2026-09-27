// Kadr player page v3: mounts ONE fragment in @remotion/player and obeys
// sync messages from the editor. Managed by Kadr — do not edit.
//
// v3 loads only the fragment it shows (src/fragments/lazy.ts). v2 imported
// the whole registry, so every iframe evaluated every fragment of every
// project in the workspace — measured 208 fragments, 380 MB of heap and 3.4 s
// to boot per iframe, and one broken fragment broke all of them.
import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Player, PlayerRef } from '@remotion/player'
import { delayRender, continueRender } from 'remotion'
import { setParamValues, paramDeclarations } from './src/_kadr/runtime'

const params = new URLSearchParams(location.search)
const id = params.get('comp') || ''
const K = window as any
K.__kadrFrame = -1
K.__kadrDrawn = -1
// remotion keeps window.remotion_renderReady false from the moment it loads
// until a delayRender/continueRender pair has run — in the Player nothing ever
// runs one, so for a fragment without its own delayRender the flag stayed
// false forever. One empty pair makes it mean "no pending delayRender".
continueRender(delayRender('kadr-boot'))
// How ThreeCanvas draws here (src/_kadr/three-preview.tsx): an editor iframe
// renders on demand at its displayed scale; a pixel-capture window (a top
// level page — it feeds snapshots) keeps the full-size continuous loop.
K.__kadrPreview = {
  demand: window.parent !== window,
  scale: Math.min(1, Math.max(0.05, Number(params.get('scale')) || 1))
}

// Edits reload only the page that shows the edited fragment (see the
// kadr-hot-scope plugin in vite.config.ts); a registry change reloads a
// page that is still waiting for its fragment to exist.
let failed = false
if (import.meta.hot) {
  import.meta.hot.on('kadr:changed', (d: { id?: string }) => {
    if (d?.id === id || (d?.id === '*registry' && failed)) location.reload()
  })
  // params.json changed (a slider let go, or the file edited by hand): new
  // values, no reload. A value somebody is still dragging stays live unless
  // the file now says something else for it — then the file wins.
  import.meta.hot.on('kadr:params', (d: { id?: string }) => {
    if (d?.id !== id) return
    const before = { ...((globalThis as any).__kadrParams?.saved ?? {}) }
    void loadSaved().then((saved) => {
      const live = { ...((globalThis as any).__kadrParams?.live ?? {}) }
      let dropped = false
      for (const k of Object.keys(live)) {
        if (JSON.stringify(saved[k]) !== JSON.stringify(before[k])) { delete live[k]; dropped = true }
      }
      setParamValues('saved', saved)
      if (dropped) setParamValues('live', live)
    })
  })
}

/** the fragment's params.json (see defineParams in src/_kadr/runtime.ts); {} when there is none */
async function loadSaved(): Promise<Record<string, unknown>> {
  try {
    const r = await fetch(`/src/fragments/${encodeURIComponent(id)}/params.json?t=${Date.now()}`,
      { headers: { accept: 'application/json' }, cache: 'no-store' })
    if (!r.ok) return {}
    const v = JSON.parse(await r.text())
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {} // missing, or not JSON (a dev server's HTML fallback)
  }
}

function App() {
  const [entry, setEntry] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<PlayerRef>(null)
  // Drift against the editor clock is corrected by nudging playbackRate a
  // few percent — a seekTo() jump of several frames reads as a visible
  // stutter on moving content; hard resync only for gross desync.
  const [rate, setRate] = useState(1)

  useEffect(() => {
    // A query of our own makes this a module id of its own, compiled fresh
    // for every page load: the registry changes as fragments come and go,
    // and a dev server that cached an in-between version handed a new page a
    // registry without its fragment («unknown composition», measured).
    import(/* @vite-ignore */ '/src/fragments/lazy.ts?kadr=' + Date.now())
      .then(({ loaders }) => {
        const load = (loaders as Record<string, () => Promise<any>>)[id]
        if (!load) throw new Error('unknown composition: ' + id)
        return Promise.all([load(), loadSaved()])
      })
      .then(([m, saved]) => {
        setParamValues('saved', saved)
        setEntry(m.fragment)
      })
      .catch((e) => { failed = true; setError(String(e?.stack || e)) })
  }, [])

  useEffect(() => {
    if (!entry) return
    let startedAt = 0
    let caughtUp = false
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      const p = ref.current
      if (!m || m.kadr !== true) return
      // values being dragged in the Inspector (replaces the whole live set)
      if (m.type === 'params') { setParamValues('live', m.values); return }
      if (!p) return
      if (m.type === 'view' && typeof m.scale === 'number') {
        K.__kadrPreview = { ...K.__kadrPreview, scale: Math.min(1, Math.max(0.05, m.scale)) }
        window.dispatchEvent(new Event('kadr-view'))
        return
      }
      if (m.type === 'sync') {
        const cur = p.getCurrentFrame()
        if (typeof m.volume === 'number') {
          p.setVolume(Math.max(0, Math.min(1, m.volume)))
          if (m.volume <= 0.001) p.mute()
          else p.unmute()
        }
        if (!m.playing) {
          startedAt = 0
          caughtUp = false
          if (p.isPlaying()) p.pause()
          setRate(1)
          if (cur !== m.frame) p.seekTo(m.frame)
        } else {
          if (!startedAt) startedAt = performance.now()
          const drift = cur - m.frame // >0 = we are ahead of the editor
          // The player takes ~70 ms to get going and was then 3 frames behind
          // for a good while (a few percent of rate recovers that slowly) —
          // measured right after every cut. While playback has only just
          // started, a lag is closed by a seek: that is the moment a jump
          // cannot be seen, the picture has only just appeared.
          // Once: repeated seeks keep the player re-rendering the same
          // frames instead of playing (measured as a new stall at +0.5 s).
          const catchUp = !caughtUp && performance.now() - startedAt < 500 && drift < -1
          if (catchUp) caughtUp = true
          if (Math.abs(drift) > 6 || catchUp) {
            p.seekTo(m.frame)
            setRate(1)
          } else {
            setRate(Math.max(0.92, Math.min(1.08, 1 - drift * 0.03)))
          }
          if (!p.isPlaying()) p.play()
        }
      }
    }
    window.addEventListener('message', onMsg)
    // snapshots poll this through fragment:capture-query to know when the
    // player really sits on the requested frame (seeks are async — grabbing
    // pixels before the seek painted returned STALE frames)
    // __kadrDrawn: the frame that is really ON the page — the player sits on
    // it, nothing is waiting in delayRender (fonts, images, models), every
    // ThreeCanvas has drawn it (src/_kadr/three-preview), and two animation
    // frames have passed for the DOM to paint. Snapshots wait for exactly
    // this; "the player reports frame N" alone was true well before a heavy
    // 3D scene had drawn anything, and the snapshot came back empty.
    // A delayRender that is never continued keeps remotion_renderReady false
    // for good — measured on a real fragment whose font loader called
    // delayRender in a useState initializer: a render React threw away left
    // its handle behind. So a pending delayRender is honoured for a while
    // after the frame settled, not forever.
    let rafId = 0
    let seen = -1
    let still = 0
    let settledAt = 0
    const trackFrame = () => {
      const cur = ref.current ? ref.current.getCurrentFrame() : -1
      K.__kadrFrame = cur
      if (cur !== seen) { seen = cur; still = 0; settledAt = performance.now() } else still++
      const gl = K.__kadrGlDrawn
      const waited = K.remotion_renderReady !== false || performance.now() - settledAt > 1500
      const ready = waited && still >= 2 && (gl === undefined || gl === cur)
      K.__kadrDrawn = ready ? cur : -1
      rafId = requestAnimationFrame(trackFrame)
    }
    rafId = requestAnimationFrame(trackFrame)
    // only now: a sync that arrived while the fragment was still loading had
    // no player to reach, and 'ready' is what makes the editor send another
    parent.postMessage({ kadr: true, type: 'ready', comp: id }, '*')
    if (params.get('collide') === '1') void runCollide(ref, entry.meta)
    return () => {
      window.removeEventListener('message', onMsg)
      cancelAnimationFrame(rafId)
    }
  }, [entry])

  if (error) {
    return React.createElement('pre',
      { style: { color: '#f66', fontFamily: 'monospace', padding: 20, whiteSpace: 'pre-wrap' } },
      error)
  }
  if (!entry) return null
  return React.createElement(Player, {
    ref,
    component: entry.component,
    durationInFrames: entry.meta.durationInFrames,
    compositionWidth: entry.meta.width,
    compositionHeight: entry.meta.height,
    fps: entry.meta.fps,
    playbackRate: rate,
    style: { width: '100vw', height: '100vh' },
    controls: false,
    clickToPlay: false,
    doubleClickToFullscreen: false,
    spaceKeyToPlayOrPause: false,
    acknowledgeRemotionLicense: true
  })
}
// ?inspect=1: no player at all — load the fragment's module and hand Kadr what
// it declares about itself (fragment.inspect, see src/_kadr/runtime.ts), with
// the functions in it (a moving caption, the camera) sampled at 30 Hz. Read
// by main through executeJavaScript (fragment:inspect → «Проверка»).
async function runInspect() {
  try {
    const { loaders } = await import(/* @vite-ignore */ '/src/fragments/lazy.ts?kadr=' + Date.now())
    const load = (loaders as Record<string, () => Promise<any>>)[id]
    if (!load) throw new Error('unknown composition: ' + id)
    const [mod, saved] = await Promise.all([load(), loadSaved()])
    // the saved values first: a camera() that reads its parameters is sampled below
    setParamValues('saved', saved)
    const f = mod.fragment
    const meta = f.meta
    const ins = f.inspect ?? {}
    const dur = meta.durationInFrames / meta.fps
    const step = 1 / 30
    const r3 = (x: number) => Math.round(Number(x) * 1000) / 1000
    const texts = (Array.isArray(ins.texts) ? ins.texts : []).map((x: any) => {
      const path: number[][] = []
      if (typeof x.at === 'function') {
        for (let t = Number(x.from); t <= Number(x.to) + 1e-9; t += step) {
          const [px, py] = x.at(t)
          path.push([r3(t), r3(px), r3(py)])
        }
      }
      return {
        from: r3(x.from), to: r3(x.to), text: String(x.text ?? ''), sub: x.sub == null ? undefined : String(x.sub),
        role: x.role, box: Array.isArray(x.box) ? x.box.map(r3) : undefined, color: x.color, path
      }
    })
    // the camera at full precision: rounding to 0.001 made a slow, smooth move
    // look like shaking (its speed stepping by one quantum per frame)
    const r6 = (x: number) => Math.round(Number(x) * 1e6) / 1e6
    const camera: unknown[] = []
    if (typeof ins.camera === 'function') {
      for (let t = 0; t <= dur + 1e-9; t += step) {
        const c = ins.camera(t)
        camera.push([r3(t), c.pos.map(r6), c.target.map(r6), c.fov ?? null])
      }
    }
    const events = (Array.isArray(ins.events) ? ins.events : [])
      .map((e: any) => ({ t: r3(e.t), kind: e.kind === 'big' ? 'big' : 'small', label: e.label == null ? undefined : String(e.label) }))
    // parameters: what the module declared (defineParams runs at import) and
    // what params.json holds; only well-formed declarations get through
    const params: Record<string, unknown> = {}
    for (const [k, d] of Object.entries(paramDeclarations() as Record<string, any>)) {
      const v = d?.value
      if (typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'boolean' && typeof v !== 'string') continue
      const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
      params[k] = {
        value: v, label: d.label == null ? undefined : String(d.label),
        min: num(d.min), max: num(d.max), step: num(d.step)
      }
    }
    K.__kadrInspect = { ok: true, meta, events, texts, camera, continuous: !!ins.continuous, params, paramValues: saved }
  } catch (e: any) {
    K.__kadrInspect = { ok: false, error: String(e?.stack || e) }
  }
}

// ?collide=1&step=<s>: play the fragment frame by frame (every `step`
// seconds) and test every pair of the 3D kit's parts (window.__kadrParts,
// registered by <Part>) for intersection with three-mesh-bvh — on the frame
// the page has really DRAWN. Result in window.__kadrCollide for main
// (fragment:collide → kadr_check with collisions).
async function runCollide(ref: { current: PlayerRef | null }, meta: { fps: number; durationInFrames: number }) {
  try {
    const THREE = await import('three')
    const { MeshBVH } = await import('three-mesh-bvh')
    const step = Math.max(1, Math.round((Number(params.get('step')) || 1 / 15) * meta.fps))
    const hits = new Map<string, number[]>()
    const seen = new Map<string, number>()
    let samples = 0
    const visible = (o: any) => { for (let x = o; x; x = x.parent) if (!x.visible) return false; return true }
    // three-mesh-bvh needs an index on BOTH geometries; smooth-by-angle
    // normals (the kit's) leave them non-indexed — a sequential one draws the same
    const ensureIndex = (g: any) => {
      if (g.index) return
      const n = g.attributes.position.count
      const a = new Uint32Array(n)
      for (let i = 0; i < n; i++) a[i] = i
      g.setIndex(new THREE.BufferAttribute(a, 1))
    }
    for (let f = 0; f < meta.durationInFrames; f += step) {
      ref.current?.seekTo(f)
      const t0 = performance.now()
      while (K.__kadrDrawn !== f && performance.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 16))
      samples++
      const parts = [...((K.__kadrParts as Set<any>) ?? [])].filter((r) => !r.exempt() && visible(r.mesh))
      const boxes = parts.map((r) => new THREE.Box3().setFromObject(r.mesh))
      for (let i = 0; i < parts.length; i++) {
        for (let j = i + 1; j < parts.length; j++) {
          const key = [parts[i].name, parts[j].name].sort().join(' ⟷ ')
          seen.set(key, (seen.get(key) ?? 0) + 1)
          if (!boxes[i].intersectsBox(boxes[j])) continue
          const a = parts[i].mesh, b = parts[j].mesh
          const ga = a.geometry as any
          ensureIndex(ga)
          ensureIndex(b.geometry)
          ga.boundsTree ??= new MeshBVH(ga)
          const m = new THREE.Matrix4().copy(a.matrixWorld).invert().multiply(b.matrixWorld)
          if (ga.boundsTree.intersectsGeometry(b.geometry, m)) {
            const list = hits.get(key) ?? []
            list.push(f)
            hits.set(key, list)
          }
        }
      }
    }
    K.__kadrCollide = {
      ok: true, fps: meta.fps, step, samples,
      pairs: [...seen].map(([pair, n]) => ({ pair, sampled: n, hitFrames: hits.get(pair) ?? [] }))
    }
  } catch (e: any) {
    K.__kadrCollide = { ok: false, error: String(e?.stack || e) }
  }
}

if (params.get('inspect') === '1') void runInspect()
else createRoot(document.getElementById('root')!).render(React.createElement(App))
