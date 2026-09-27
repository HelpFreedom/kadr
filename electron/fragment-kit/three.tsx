// Kadr's 3D kit for fragments: import from '@kadr/three'. Managed by Kadr —
// do not edit (rewritten when Kadr updates); copy a piece into your own code
// if you need it different.
//
// Grown out of a real film (13 revisions of a printed part, one continuous 3D
// shot cut to a song) and generalised. The conventions:
// * Units: 1 scene unit = 10 cm by default (useModel's unitsPerMeter: 10) —
//   a 150 mm figure is 1.5 units tall, comfortable for cameras and lights.
// * Y is up; models come Y-up from Kadr's importer (CAD Z-up is converted).
// * EVERYTHING is a function of time: pass `t` (composition seconds) in, never
//   read a clock — the preview, the checks and the render must all agree.
// * Physical honesty: parts must not pass through each other (kadr_check with
//   collisions finds where they do), a change is shown by a print LAYER
//   sweeping up (new below, old above), a removal by a red layer sweeping down.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useThree } from '@react-three/fiber'
import { ThreeCanvas } from '@remotion/three'
import { AbsoluteFill, Sequence, Video, continueRender, delayRender, useVideoConfig } from 'remotion'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

export type V3 = [number, number, number]

// ------------------------------------------------------------------ models

export interface ModelPart {
  name: string
  /** smooth-shaded by angle (creases stay sharp) */
  geometry: THREE.BufferGeometry
  /** feature edges */
  edges: THREE.BufferGeometry
  box: THREE.Box3
  center: V3
  size: V3
}
export interface Model {
  parts: Record<string, ModelPart>
  list: ModelPart[]
  box: THREE.Box3
  center: V3
  size: V3
}
export interface ModelOpts {
  /** scene units per metre (default 10: 1 unit = 10 cm) */
  unitsPerMeter?: number
  /** normals are smoothed between faces closer than this (degrees, default 30) */
  creaseDeg?: number
  /** edges are drawn between faces further apart than this (degrees, default 30) */
  edgeDeg?: number
  /** 'base' (default): the whole model centred in x/z and standing on y = 0 —
      parts keep their places relative to each other; 'file': the file's own
      coordinates (a CAD assembly placed in a scene of its own) */
  origin?: 'base' | 'file'
}

const loaded = new Map<string, Model>()
const loading = new Map<string, Promise<Model>>()
const v3 = (v: THREE.Vector3): V3 => [v.x, v.y, v.z]

/**
 * Load a model (a GLB — Kadr's importer writes them into kadr-lib/models:
 * `import figure from '@lib/models/figure.glb'`). ONE delayRender per model, tied
 * to the load itself, not to a component: a delayRender made while React
 * renders a component can be orphaned when React discards that render, and a
 * render then waits for it forever.
 */
export function loadModel(url: string, opts: ModelOpts = {}): Promise<Model> {
  const key = url + '|' + JSON.stringify(opts)
  const hit = loading.get(key)
  if (hit) return hit
  const handle = delayRender(`model ${url}`, { timeoutInMilliseconds: 120000 })
  const p = (async () => {
    try {
      const buf = await (await fetch(url)).arrayBuffer()
      const gltf = await new GLTFLoader().parseAsync(buf, '')
      const k = opts.unitsPerMeter ?? 10
      const crease = ((opts.creaseDeg ?? 30) * Math.PI) / 180
      const list: ModelPart[] = []
      gltf.scene.updateMatrixWorld(true)
      gltf.scene.traverse((o) => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        const g = m.geometry.clone()
        g.applyMatrix4(m.matrixWorld)
        g.scale(k, k, k)
        g.deleteAttribute('normal')
        const geometry = toCreasedNormals(g, crease)
        geometry.computeBoundingBox()
        const box = geometry.boundingBox!.clone()
        list.push({
          name: m.name || `part${list.length + 1}`,
          geometry,
          edges: new THREE.EdgesGeometry(g, opts.edgeDeg ?? 30),
          box,
          center: v3(box.getCenter(new THREE.Vector3())),
          size: v3(box.getSize(new THREE.Vector3()))
        })
      })
      let box = new THREE.Box3()
      for (const p of list) box.union(p.box)
      if ((opts.origin ?? 'base') === 'base' && list.length) {
        const c = box.getCenter(new THREE.Vector3())
        const dx = -c.x, dy = -box.min.y, dz = -c.z
        for (const p of list) {
          p.geometry.translate(dx, dy, dz)
          p.edges.translate(dx, dy, dz)
          p.geometry.computeBoundingBox()
          p.box = p.geometry.boundingBox!.clone()
          p.center = v3(p.box.getCenter(new THREE.Vector3()))
        }
        box = new THREE.Box3()
        for (const p of list) box.union(p.box)
      }
      const model: Model = {
        parts: Object.fromEntries(list.map((p) => [p.name, p])),
        list,
        box,
        center: v3(box.getCenter(new THREE.Vector3())),
        size: v3(box.getSize(new THREE.Vector3()))
      }
      loaded.set(key, model)
      return model
    } finally {
      continueRender(handle)
    }
  })()
  p.catch((e) => console.error(`[kadr] model ${url}: ${e}`))
  loading.set(key, p)
  return p
}

/** The model, or null while it loads (the render waits for it). */
export function useModel(url: string, opts: ModelOpts = {}): Model | null {
  const key = url + '|' + JSON.stringify(opts)
  const [, bump] = useState(0)
  const m = loaded.get(key) ?? null
  // start the load (and its delayRender) during render — the frame must wait
  if (!m) void loadModel(url, opts).catch(() => {})
  useEffect(() => {
    if (m) return
    let alive = true
    loadModel(url, opts).then(() => { if (alive) bump((x) => x + 1) }, () => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, !!m])
  return m
}

// ------------------------------------------------------------------ stage

/** The canvas: a ThreeCanvas at the composition's size, with shadows. */
export const Scene3D: React.FC<{ width: number; height: number; children: React.ReactNode; background?: string; style?: React.CSSProperties }> = ({
  width, height, children, background, style
}) => (
  <AbsoluteFill style={{ background }}>
    <ThreeCanvas width={width} height={height} shadows style={style}
      gl={{ antialias: true, alpha: !background, preserveDrawingBuffer: true }}>
      {children}
    </ThreeCanvas>
  </AbsoluteFill>
)

/** Studio light: soft room reflections, a key with shadows, a rim, a fill; clipping on (for layers). */
export const Studio: React.FC<{ exposure?: number; env?: number; intensity?: number; rim?: string; fill?: string; shadow?: boolean; shadowSize?: number }> = ({
  exposure = 1, env = 0.55, intensity: keyI = 2.6, rim = '#9ec9ff', fill = '#b9a0ff', shadow = true, shadowSize = 3
}) => {
  const { gl, scene } = useThree()
  const tex = useMemo(() => {
    const pm = new THREE.PMREMGenerator(gl)
    const t = pm.fromScene(new RoomEnvironment(), 0.04).texture
    pm.dispose()
    return t
  }, [gl])
  gl.localClippingEnabled = true
  gl.toneMapping = THREE.ACESFilmicToneMapping
  gl.toneMappingExposure = exposure
  scene.environment = tex
  ;(scene as unknown as { environmentIntensity: number }).environmentIntensity = env
  const s = shadowSize
  return (
    <>
      <ambientLight intensity={0.2} />
      <directionalLight position={[-3.5, 6, 2.5]} intensity={keyI} castShadow={shadow} shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-s} shadow-camera-right={s} shadow-camera-top={s} shadow-camera-bottom={-s}
        shadow-camera-near={0.5} shadow-camera-far={20} shadow-bias={-0.0004} shadow-normalBias={0.01} />
      <directionalLight position={[3.5, 2.5, -3]} intensity={keyI * 0.8} color={rim} />
      <directionalLight position={[2, 1.2, 4]} intensity={keyI * 0.5} color={fill} />
    </>
  )
}

/** A floor that only catches shadows. */
export const ShadowFloor: React.FC<{ y?: number; opacity?: number; size?: number }> = ({ y = 0, opacity = 0.45, size = 12 }) => (
  <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, y, 0]} receiveShadow>
    <planeGeometry args={[size, size]} />
    <shadowMaterial transparent opacity={opacity} />
  </mesh>
)

// ------------------------------------------------------------------ camera

export interface CamKey {
  /** composition seconds */
  t: number
  target: V3
  /** azimuth around the target, degrees (0 = looking along −z… from +z) */
  az: number
  /** elevation, degrees */
  el: number
  /** distance to the target, scene units */
  r: number
  fov?: number
  /** the subject shifted right in the frame by this share of the frame width (−0.5..0.5) */
  shift?: number
}
export interface CamState { pos: V3; target: V3; fov: number; shift: number }

/** Fritsch–Carlson monotone cubic through (xs, ys): never overshoots a key. */
function monotone(xs: number[], ys: number[]) {
  const n = xs.length
  const d: number[] = [], m: number[] = new Array(n).fill(0)
  for (let i = 0; i + 1 < n; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-9, xs[i + 1] - xs[i]))
  m[0] = d[0] ?? 0
  m[n - 1] = d[n - 2] ?? 0
  for (let i = 1; i + 1 < n; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2
  for (let i = 0; i + 1 < n; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / d[i], b = m[i + 1] / d[i], h = a * a + b * b
    if (h > 9) { const s = 3 / Math.sqrt(h); m[i] = s * a * d[i]; m[i + 1] = s * b * d[i] }
  }
  return (x: number) => {
    if (n === 1 || x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (i + 2 < n && x > xs[i + 1]) i++
    const h = xs[i + 1] - xs[i], s = (x - xs[i]) / h
    const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]
  }
}

/**
 * ONE camera for the whole shot: keys in time, a monotone spline through every
 * channel (target xyz, azimuth, elevation, distance, fov, shift) — no
 * overshoot, no stop between keys unless two keys repeat a value. Export the
 * returned function as `inspect.camera` and kadr_check will look for jerks.
 */
export function cameraPath(keys: CamKey[]): (t: number) => CamState {
  const ks = [...keys].sort((a, b) => a.t - b.t)
  const xs = ks.map((k) => k.t)
  const ch = (f: (k: CamKey) => number) => monotone(xs, ks.map(f))
  const tx = ch((k) => k.target[0]), ty = ch((k) => k.target[1]), tz = ch((k) => k.target[2])
  const az = ch((k) => k.az), el = ch((k) => k.el), r = ch((k) => k.r)
  const fov = ch((k) => k.fov ?? 32), shift = ch((k) => k.shift ?? 0)
  return (t: number) => {
    const target: V3 = [tx(t), ty(t), tz(t)]
    const a = (az(t) * Math.PI) / 180, e = (el(t) * Math.PI) / 180, d = r(t)
    const pos: V3 = [target[0] + Math.sin(a) * Math.cos(e) * d, target[1] + Math.sin(e) * d, target[2] + Math.cos(a) * Math.cos(e) * d]
    return { pos, target, fov: fov(t), shift: shift(t) }
  }
}

/** Put the r3f camera where `cam` says (shift moves the subject across the frame). */
export const Camera: React.FC<{ cam: CamState; aspect?: number }> = ({ cam, aspect = 16 / 9 }) => {
  const { camera } = useThree()
  const c = camera as THREE.PerspectiveCamera
  c.position.set(...cam.pos)
  c.fov = cam.fov
  c.near = 0.02
  c.far = 200
  c.aspect = aspect
  c.lookAt(...cam.target)
  c.updateProjectionMatrix()
  // a lens shift, not a turn: the subject slides across without the perspective changing
  if (cam.shift) c.setViewOffset(1000 * aspect, 1000, -cam.shift * 1000 * aspect, 0, 1000 * aspect, 1000)
  else c.clearViewOffset()
  return null
}

/** Where a world point lands in the frame, px (same camera maths as <Camera>). */
export function project(p: V3, cam: CamState, width = 1920, height = 1080): [number, number] {
  const c = new THREE.PerspectiveCamera(cam.fov, width / height, 0.02, 200)
  c.position.set(...cam.pos)
  c.lookAt(...cam.target)
  if (cam.shift) c.setViewOffset(1000 * (width / height), 1000, -cam.shift * 1000 * (width / height), 0, 1000 * (width / height), 1000)
  c.updateMatrixWorld()
  c.updateProjectionMatrix()
  const v = new THREE.Vector3(...p).project(c)
  return [(v.x * 0.5 + 0.5) * width, (-v.y * 0.5 + 0.5) * height]
}

// ------------------------------------------------------------------ parts

/** registered meshes, for the collision check (player page ?collide=1) */
type Reg = { name: string; mesh: THREE.Mesh; exempt: () => boolean }
const REG: Set<Reg> = ((window as unknown as { __kadrParts?: Set<Reg> }).__kadrParts ??= new Set())

export interface Look {
  color?: string
  metal?: number
  rough?: number
  /** 0..1 */
  opacity?: number
  /** see-through body that does not hide what is behind it */
  xray?: boolean
  /** dark feature edges, 0..1 */
  edges?: number
  /** a coloured outline around the part (a change: yellow; going away: red), 0..1 */
  outline?: number
  outlineColor?: string
  /** self-glow, 0..1 */
  glow?: number
  glowColor?: string
}

/** A print layer: the part shows only below (or above) world height `y`. */
export type LayerCut = { y: number; keep: 'below' | 'above' }

const outlineMaterial = (color: string) => {
  const m = new THREE.MeshBasicMaterial({ color, side: THREE.BackSide, transparent: true, depthWrite: false })
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uWidth = { value: 0.012 }
    sh.vertexShader = 'uniform float uWidth;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n transformed += normalize(objectNormal) * uWidth;')
  }
  return m
}

/**
 * One part of a model. `layer` shows it only below/above a world height (the
 * print-layer reveal: a `Layer` disk sweeps up with it). `exempt` keeps it
 * out of the collision check (a ghost, a layer in progress, an x-ray view).
 */
export const Part: React.FC<{
  part: ModelPart
  look?: Look
  layer?: LayerCut
  position?: V3
  rotation?: V3
  scale?: number
  castShadow?: boolean
  exempt?: boolean
  name?: string
}> = ({ part, look = {}, layer, position = [0, 0, 0], rotation = [0, 0, 0], scale = 1, castShadow = true, exempt, name }) => {
  const { color = '#8f63e8', metal = 0.05, rough = 0.48, opacity = 1, xray = false, edges = 0.35, outline = 0, outlineColor = '#ffd23f', glow = 0, glowColor } = look
  const mats = useMemo(() => ({
    body: new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide, clearcoat: 0.2, clearcoatRoughness: 0.5 }),
    edge: new THREE.LineBasicMaterial({ transparent: true }),
    line: outlineMaterial(outlineColor)
  }), [outlineColor])
  const plane = useMemo(() => new THREE.Plane(), [])
  const planes = layer ? [plane] : []
  if (layer) {
    if (layer.keep === 'below') { plane.normal.set(0, -1, 0); plane.constant = layer.y } else { plane.normal.set(0, 1, 0); plane.constant = -layer.y }
  }
  mats.body.color.set(color); mats.body.metalness = metal; mats.body.roughness = rough
  mats.body.emissive.set(glowColor ?? color); mats.body.emissiveIntensity = glow
  mats.body.transparent = xray || opacity < 0.999; mats.body.opacity = opacity; mats.body.depthWrite = !xray && opacity > 0.5
  mats.body.clippingPlanes = planes
  mats.edge.color.set('#05060c'); mats.edge.opacity = edges * opacity; mats.edge.clippingPlanes = planes
  mats.line.opacity = outline; mats.line.clippingPlanes = planes
  const ref = useRef<THREE.Mesh>(null)
  const exemptNow = exempt || xray || opacity < 0.5 || !!layer
  const exemptRef = useRef(exemptNow)
  exemptRef.current = exemptNow
  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const r: Reg = { name: name ?? part.name, mesh, exempt: () => exemptRef.current }
    REG.add(r)
    return () => { REG.delete(r) }
  }, [part, name])
  if (opacity <= 0.003) return null
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <mesh ref={ref} geometry={part.geometry} material={mats.body} castShadow={castShadow && opacity > 0.5 && !xray} receiveShadow />
      {edges > 0 && <lineSegments geometry={part.edges} material={mats.edge} />}
      {outline > 0.003 && <mesh geometry={part.geometry} material={mats.line} renderOrder={5} />}
    </group>
  )
}

/** Every part of a model with one look (overrides per part name in `looks`). */
export const ModelView: React.FC<{ model: Model; look?: Look; looks?: Record<string, Look>; layer?: LayerCut; position?: V3; rotation?: V3; scale?: number }> = ({
  model, look, looks = {}, layer, position, rotation, scale
}) => (
  <group position={position} rotation={rotation} scale={scale}>
    {model.list.map((p) => <Part key={p.name} part={p} look={{ ...look, ...looks[p.name] }} layer={layer} />)}
  </group>
)

/** The glowing disk of a print layer at world height `y`. */
export const Layer: React.FC<{ y: number; radius?: number; center?: [number, number]; color?: string; k?: number }> = ({
  y, radius = 1, center = [0, 0], color = '#41d6ff', k = 1
}) => {
  if (k <= 0.003) return null
  return (
    <group position={[center[0], y, center[1]]} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh>
        <circleGeometry args={[radius, 96]} />
        <meshBasicMaterial color={color} transparent opacity={0.08 * k} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh>
        <ringGeometry args={[radius * 0.985, radius, 128]} />
        <meshBasicMaterial color={color} transparent opacity={0.9 * k} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  )
}

/**
 * A stress map ("FEM-like"): colour by nearness to hot points, computed in the
 * SHADER — the version this replaces recoloured every vertex on the CPU every
 * frame and cost a real film a third of its frame time.
 */
export const HeatPart: React.FC<{ part: ModelPart; hot: V3[]; radius: number; k?: number; floor?: number; position?: V3; layer?: LayerCut }> = ({
  part, hot, radius, k = 1, floor = 0.08, position = [0, 0, 0], layer
}) => {
  // the uniforms exist BEFORE the shader compiles and are updated on every
  // render: the first frame (and a paused preview) must already be hot
  const u = useMemo(() => ({
    uHot: { value: Array.from({ length: 4 }, () => new THREE.Vector3(1e6, 1e6, 1e6)) },
    uR: { value: 1 }, uK: { value: 1 }, uFloor: { value: 0.08 }
  }), [])
  const mat = useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0, side: THREE.DoubleSide })
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u)
      sh.vertexShader = 'varying vec3 vWorldK;\n' + sh.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\n vWorldK = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      sh.fragmentShader = [
        'varying vec3 vWorldK; uniform vec3 uHot[4]; uniform float uR; uniform float uK; uniform float uFloor;',
        'vec3 turboK(float x){ x=clamp(x,0.,1.);',
        ' vec3 c0=vec3(.12,.16,.55), c1=vec3(.1,.55,.95), c2=vec3(.2,.9,.45), c3=vec3(.98,.85,.15), c4=vec3(1.,.45,.08), c5=vec3(.9,.08,.1);',
        ' if(x<.25) return mix(c0,c1,x/.25); if(x<.5) return mix(c1,c2,(x-.25)/.25); if(x<.72) return mix(c2,c3,(x-.5)/.22);',
        ' if(x<.88) return mix(c3,c4,(x-.72)/.16); return mix(c4,c5,(x-.88)/.12); }',
        sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
 float heat = 0.0;
 for (int i = 0; i < 4; i++) { vec3 d = vWorldK - uHot[i]; heat = max(heat, exp(-dot(d, d) / (uR * uR))); }
 diffuseColor.rgb = turboK(max(uFloor, heat) * uK);`)
      ].join('\n')
    }
    return m
  }, [u])
  for (let i = 0; i < 4; i++) u.uHot.value[i].set(...(hot[i] ?? [1e6, 1e6, 1e6]))
  u.uR.value = radius
  u.uK.value = k
  u.uFloor.value = floor
  const plane = useMemo(() => new THREE.Plane(), [])
  if (layer) {
    if (layer.keep === 'below') { plane.normal.set(0, -1, 0); plane.constant = layer.y } else { plane.normal.set(0, 1, 0); plane.constant = -layer.y }
  }
  mat.clippingPlanes = layer ? [plane] : []
  return (
    <group position={position}>
      <mesh geometry={part.geometry} material={mat} castShadow receiveShadow />
      <lineSegments geometry={part.edges}>
        <lineBasicMaterial color="#05060c" transparent opacity={0.25} clippingPlanes={mat.clippingPlanes} />
      </lineSegments>
    </group>
  )
}

/** A cable along a smooth curve, grown to share `p` (0..1). */
export const Cord: React.FC<{ pts: V3[]; p?: number; r?: number; color?: string; glow?: number; glowColor?: string }> = ({
  pts, p = 1, r = 0.02, color = '#1c1e26', glow = 0, glowColor = '#41d6ff'
}) => {
  const key = JSON.stringify(pts)
  const curve = useMemo(() => new THREE.CatmullRomCurve3(pts.map((q) => new THREE.Vector3(...q)), false, 'catmullrom', 0.5), [key])
  const pp = Math.max(0.01, Math.min(1, p))
  const geo = useMemo(() => {
    const sub: THREE.Vector3[] = []
    for (let i = 0; i <= 60; i++) sub.push(curve.getPointAt((i / 60) * pp))
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(sub), 90, r, 12, false)
  }, [curve, pp, r])
  if (p <= 0.001) return null
  return (
    <mesh geometry={geo} castShadow>
      <meshPhysicalMaterial color={color} roughness={0.55} metalness={0.1} emissive={glowColor} emissiveIntensity={glow} />
    </mesh>
  )
}

// ------------------------------------------------------------ 2D over 3D

const fadeK = (t: number, from: number, to: number, fade = 0.3) =>
  Math.max(0, Math.min(1, (t - from) / fade, (to - t) / fade))

/**
 * A caption that STAYS PUT with a line to a point of the model: the text is
 * fixed on screen (readable), only the line follows the 3D point. Declare it
 * in inspect.texts too (calloutText gives the record) so kadr_check can time it.
 */
export const Callout: React.FC<{
  t: number; from: number; to: number
  text: string; sub?: string
  /** the world point the line goes to */
  at: V3
  cam: CamState
  /** where the text sits, px */
  x?: number; y?: number
  color?: string
  width?: number; height?: number
  font?: string
}> = ({ t, from, to, text, sub, at, cam, x = 110, y = 150, color = '#ffd23f', width = 1920, height = 1080, font = 'Inter, sans-serif' }) => {
  const k = fadeK(t, from, to)
  if (k <= 0.001) return null
  const [px, py] = project(at, cam, width, height)
  const lx = x + Math.max(text.length * 26, 200) + 30, ly = y + 30
  const draw = Math.max(0, Math.min(1, (t - from - 0.1) / 0.35))
  const len = Math.hypot(px - lx, py - ly) + 40
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', opacity: k }}>
      <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <polyline points={`${lx},${ly} ${lx + 40},${ly} ${px},${py}`} fill="none" stroke={color} strokeWidth={2}
          strokeDasharray={len} strokeDashoffset={len * (1 - draw)} opacity={0.85} />
        <circle cx={px} cy={py} r={7} fill="none" stroke={color} strokeWidth={2.4} opacity={draw} />
      </svg>
      <div style={{ position: 'absolute', left: x, top: y, fontFamily: font, color: '#fff' }}>
        <div style={{ fontSize: 50, fontWeight: 800, letterSpacing: -1 }}>{text}</div>
        {sub && <div style={{ fontSize: 26, opacity: 0.7, marginTop: 6 }}>{sub}</div>}
      </div>
    </div>
  )
}

/** The inspect record of a Callout (fully visible between fade-in and fade-out). */
export const calloutText = (c: { from: number; to: number; text: string; sub?: string; x?: number; y?: number; color?: string }) => ({
  from: c.from + 0.3, to: c.to - 0.3, text: c.text, sub: c.sub, role: 'title' as const,
  box: [c.x ?? 110, c.y ?? 150, Math.max(c.text.length * 26, 200), c.sub ? 110 : 64] as [number, number, number, number],
  color: '#ffffff'
})

/** Numbered balloons of an exploded view, each with a leader line to its part. */
export const Balloons: React.FC<{
  t: number; cam: CamState
  items: { n: number | string; at: V3; label?: string; from: number; to: number; dx?: number; dy?: number }[]
  color?: string; width?: number; height?: number
}> = ({ t, cam, items, color = '#ffffff', width = 1920, height = 1080 }) => (
  <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
    <svg width={width} height={height} style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
      {items.map((b, i) => {
        const k = fadeK(t, b.from, b.to, 0.25)
        if (k <= 0.001) return null
        const [px, py] = project(b.at, cam, width, height)
        const bx = px + (b.dx ?? -200), by = py + (b.dy ?? -60)
        return (
          <g key={i} opacity={k}>
            <line x1={px} y1={py} x2={bx} y2={by} stroke={color} strokeWidth={1.6} opacity={0.7} />
            <circle cx={px} cy={py} r={4} fill={color} />
            <circle cx={bx} cy={by} r={22} fill="rgba(10,10,14,0.85)" stroke={color} strokeWidth={2} />
            <text x={bx} y={by + 8} textAnchor="middle" fontFamily="Inter, sans-serif" fontSize={22} fontWeight={700} fill={color}>{b.n}</text>
            {b.label && <text x={bx + (b.dx !== undefined && b.dx > 0 ? 34 : -34)} y={by + 8} textAnchor={b.dx !== undefined && b.dx > 0 ? 'start' : 'end'}
              fontFamily="Inter, sans-serif" fontSize={24} fill={color}>{b.label}</text>}
          </g>
        )
      })}
    </svg>
  </div>
)

/**
 * «Чертёж → реальность»: a portrait video window opens over the 3D (a vertical
 * slot widening from its centre), then — from `cardAt` — the frame behind it
 * fills with a blurred, darkened copy of the same video and the window settles
 * into a card. Align the 3D camera with the video's first frame for the match
 * cut (defineParams sliders in @kadr/runtime are made for that). `src`: the video's URL
 * (`import clip from '@lib/media/clip.mp4'` — «Подготовить для фрагмента»
 * makes an SDR, keyframe-dense copy there). Uses <Video>, not OffthreadVideo.
 */
export const PortraitReveal: React.FC<{
  t: number
  /** composition seconds: the window starts to open */
  from: number
  src: string
  /** the window, px: [x, y, w, h] */
  rect: [number, number, number, number]
  /** composition seconds: the blurred background comes up (default from + 1.2) */
  cardAt?: number
  open?: number
  glow?: string
  radius?: number
}> = ({ t, from, src, rect, cardAt, open = 0.6, glow = '#b48cff', radius = 28 }) => {
  const { fps } = useVideoConfig()
  if (t < from) return null
  const k = Math.max(0, Math.min(1, (t - from) / open))
  const e = 1 - Math.pow(1 - k, 3)
  const card = cardAt ?? from + 1.2
  const bg = Math.max(0, Math.min(1, (t - card) / 0.8))
  const [x, y, w, h] = rect
  const inset = ((1 - e) * w) / 2
  return (
    <Sequence from={Math.round(from * fps)} layout="none">
      <AbsoluteFill style={{ opacity: bg }}>
        <Video src={src} muted style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(38px) brightness(0.45) saturate(1.2)', transform: 'scale(1.15)' }} />
      </AbsoluteFill>
      <div style={{
        position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: radius, overflow: 'hidden',
        clipPath: `inset(0 ${inset}px 0 ${inset}px round ${radius}px)`,
        boxShadow: `0 0 ${40 + 60 * bg}px ${glow}`
      }}>
        <Video src={src} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>
    </Sequence>
  )
}
