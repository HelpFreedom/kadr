// 3D models as project assets: STL, 3MF, OBJ, GLB/glTF and STEP in, one GLB
// + a description + a thumbnail out, in <project>/kadr-lib/models/ — where a
// fragment imports it ('@lib/models/<name>.glb', read with useModel() from
// '@kadr/three').
//
// Why here and not in a fragment: the session this came from converted every
// model by hand (STL/3MF → Blender decimation → base64 TypeScript modules of a
// megabyte each, copied into eight fragments), and got a 3MF wrong on the way —
// the build item's transform was not applied, so a model built for a 0.079
// scale came out the size of a house, and the next one as a 2 mm speck. The
// rules that make a CAD file come out right are all in this file:
//
// * 3MF: the BUILD decides what is printed and where — each <item> places an
//   object with its own transform, objects may be <components> of other
//   objects (with transforms of their own), and a component may live in
//   ANOTHER model file of the package (Bambu Studio writes every mesh to
//   3D/Objects/*.model: the production extension's p:path). Transforms are 3MF
//   row-vector matrices, applied component → object → item. `unit` scales to mm.
// * CAD formats are Z-up (STL, 3MF, STEP); three.js is Y-up: (x, y, z) →
//   (x, z, −y). glTF is Y-up already; OBJ from DCC tools usually is too.
// * glTF is in METRES; the GLB written here is too (spec), so any viewer shows
//   the model at its real size. useModel() scales to the scene's units.
// * STL has no shared vertices: they are welded before anything else, or the
//   decimation and the smooth normals see a soup of separate triangles.
// * Big meshes are decimated to a triangle budget (meshoptimizer), per part in
//   proportion, so small parts keep their shape.
import { ipcMain, nativeImage } from 'electron'
import { promises as fs, existsSync } from 'fs'
import { join, basename, extname, dirname } from 'path'
import { unzipSync, strFromU8 } from 'fflate'
import type { ModelInfo } from '@shared/types'

export interface MeshPart {
  name: string
  /** mm, Y up */
  positions: Float32Array
  indices: Uint32Array
}

export const MODEL_EXTS = ['.stl', '.3mf', '.obj', '.glb', '.gltf', '.step', '.stp']

// ------------------------------------------------------------------- helpers

type M4 = number[] // 3MF row-vector 4×3 as 12 numbers: m00 m01 m02 m10 … m30 m31 m32

const IDENT: M4 = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]
/** a × b for 3MF row-vector matrices (apply a, then b) */
function mul(a: M4, b: M4): M4 {
  const r: M4 = new Array(12).fill(0)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0
      for (let k = 0; k < 3; k++) s += (i < 3 ? a[i * 3 + k] : a[9 + k]) * b[k * 3 + j]
      r[i * 3 + j] = s + (i === 3 ? b[9 + j] : 0)
    }
  }
  return r
}
const applyM = (m: M4, x: number, y: number, z: number): [number, number, number] => [
  x * m[0] + y * m[3] + z * m[6] + m[9],
  x * m[1] + y * m[4] + z * m[7] + m[10],
  x * m[2] + y * m[5] + z * m[8] + m[11]
]
const parseM = (s: string | undefined): M4 => {
  if (!s) return IDENT
  const v = s.trim().split(/\s+/).map(Number)
  return v.length === 12 && v.every(Number.isFinite) ? v : IDENT
}

/** attributes of one XML start tag */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2]
  return out
}

/** merge vertices at the same position (STL has none shared) */
function weld(pos: Float32Array, idx: Uint32Array | null): { positions: Float32Array; indices: Uint32Array } {
  const n = pos.length / 3
  const map = new Map<string, number>()
  const out: number[] = []
  const remap = new Uint32Array(n)
  const q = (v: number) => Math.round(v * 1e4)
  for (let i = 0; i < n; i++) {
    const key = `${q(pos[i * 3])},${q(pos[i * 3 + 1])},${q(pos[i * 3 + 2])}`
    let j = map.get(key)
    if (j === undefined) {
      j = out.length / 3
      map.set(key, j)
      out.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])
    }
    remap[i] = j
  }
  const src = idx ?? Uint32Array.from({ length: n }, (_, i) => i)
  const indices = new Uint32Array(src.length)
  for (let i = 0; i < src.length; i++) indices[i] = remap[src[i]]
  return { positions: Float32Array.from(out), indices: dropDegenerate(indices) }
}

function dropDegenerate(idx: Uint32Array): Uint32Array {
  const keep: number[] = []
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = idx[i], b = idx[i + 1], c = idx[i + 2]
    if (a !== b && b !== c && a !== c) keep.push(a, b, c)
  }
  return Uint32Array.from(keep)
}

/** CAD Z-up → Y-up, in place */
function zUpToYUp(p: Float32Array) {
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1]
    p[i + 1] = p[i + 2]
    p[i + 2] = -y
  }
}

// ------------------------------------------------------------------- parsers

function parseSTL(buf: Buffer, name: string): MeshPart[] {
  // binary when the size matches the triangle count (an ASCII file may begin with "solid" too)
  if (buf.length >= 84) {
    const n = buf.readUInt32LE(80)
    if (84 + n * 50 === buf.length) {
      const pos = new Float32Array(n * 9)
      for (let i = 0; i < n; i++) {
        const o = 84 + i * 50 + 12
        for (let k = 0; k < 9; k++) pos[i * 9 + k] = buf.readFloatLE(o + k * 4)
      }
      const w = weld(pos, null)
      return [{ name, ...w }]
    }
  }
  const text = buf.toString('utf8')
  const vs: number[] = []
  for (const m of text.matchAll(/vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g)) vs.push(Number(m[1]), Number(m[2]), Number(m[3]))
  if (!vs.length || vs.length % 9) throw new Error('STL: не удалось прочитать треугольники')
  return [{ name, ...weld(Float32Array.from(vs), null) }]
}

interface Obj3mf {
  id: string
  name?: string
  mesh?: { v: Float32Array; t: Uint32Array }
  comps?: { objectid: string; path?: string; transform: M4 }[]
}

function parse3MF(buf: Buffer, fallbackName: string): MeshPart[] {
  const zip = unzipSync(new Uint8Array(buf))
  const norm = (p: string) => p.replace(/^\/+/, '')
  const files = new Map<string, { objects: Map<string, Obj3mf>; build: { objectid: string; transform: M4; partnumber?: string }[]; scale: number }>()
  const UNIT: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 }
  const load = (path: string) => {
    const key = norm(path)
    const hit = files.get(key)
    if (hit) return hit
    const data = zip[key]
    if (!data) throw new Error(`3MF: в пакете нет ${key}`)
    const xml = strFromU8(data)
    const modelTag = xml.match(/<model\b[^>]*>/)?.[0] ?? ''
    const scale = UNIT[attrs(modelTag).unit ?? 'millimeter'] ?? 1
    const objects = new Map<string, Obj3mf>()
    for (const om of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const a = attrs(om[1])
      const body = om[2]
      const o: Obj3mf = { id: a.id, name: a.name }
      const vx = body.match(/<vertices>([\s\S]*?)<\/vertices>/)
      if (vx) {
        const vs: number[] = []
        for (const vm of vx[1].matchAll(/<vertex\b([^>]*)\/?>/g)) {
          const va = attrs(vm[1])
          vs.push(Number(va.x) * scale, Number(va.y) * scale, Number(va.z) * scale)
        }
        const ts: number[] = []
        const tx = body.match(/<triangles>([\s\S]*?)<\/triangles>/)
        if (tx) {
          for (const tm of tx[1].matchAll(/<triangle\b([^>]*)\/?>/g)) {
            const ta = attrs(tm[1])
            ts.push(Number(ta.v1), Number(ta.v2), Number(ta.v3))
          }
        }
        o.mesh = { v: Float32Array.from(vs), t: Uint32Array.from(ts) }
      }
      const cx = body.match(/<components>([\s\S]*?)<\/components>/)
      if (cx) {
        o.comps = [...cx[1].matchAll(/<component\b([^>]*)\/?>/g)].map((cm) => {
          const ca = attrs(cm[1])
          return { objectid: ca.objectid, path: ca['p:path'], transform: scaleT(parseM(ca.transform), scale) }
        })
      }
      objects.set(o.id, o)
    }
    const build = [...(xml.match(/<build\b[\s\S]*?<\/build>/)?.[0] ?? '').matchAll(/<item\b([^>]*)\/?>/g)].map((im) => {
      const ia = attrs(im[1])
      return { objectid: ia.objectid, transform: scaleT(parseM(ia.transform), scale), partnumber: ia.partnumber }
    })
    const f = { objects, build, scale }
    files.set(key, f)
    return f
  }
  // a transform's translation is in the file's unit: bring it to mm
  function scaleT(m: M4, s: number): M4 {
    if (s === 1) return m
    const r = [...m]
    r[9] *= s; r[10] *= s; r[11] *= s
    return r
  }
  const main = load('3D/3dmodel.model')
  const parts: MeshPart[] = []
  const expand = (file: string, id: string, T: M4, label: string, depth: number) => {
    if (depth > 16) throw new Error('3MF: слишком глубокая вложенность компонентов')
    const f = load(file)
    const o = f.objects.get(id)
    if (!o) throw new Error(`3MF: нет объекта ${id} в ${file}`)
    if (o.mesh && o.mesh.t.length) {
      const src = o.mesh.v
      const pos = new Float32Array(src.length)
      for (let i = 0; i < src.length; i += 3) {
        const [x, y, z] = applyM(T, src[i], src[i + 1], src[i + 2])
        pos[i] = x; pos[i + 1] = y; pos[i + 2] = z
      }
      parts.push({ name: o.name || label, ...weld(pos, o.mesh.t) })
    }
    for (const c of o.comps ?? []) {
      expand(c.path ? norm(c.path) : file, c.objectid, mul(c.transform, T), o.name || label, depth + 1)
    }
  }
  const items = main.build.length ? main.build : [...main.objects.keys()].map((id) => ({ objectid: id, transform: IDENT, partnumber: undefined }))
  items.forEach((it, i) => expand('3D/3dmodel.model', it.objectid, it.transform, it.partnumber || `${fallbackName}-${i + 1}`, 0))
  if (!parts.length) throw new Error('3MF: в сборке нет сеток')
  return parts
}

function parseOBJ(text: string, fallbackName: string): MeshPart[] {
  const v: number[] = []
  const groups = new Map<string, number[]>()
  let cur = fallbackName
  const at = (s: string) => {
    const i = parseInt(s.split('/')[0], 10)
    return i < 0 ? v.length / 3 + i : i - 1
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('v ')) {
      const [, x, y, z] = line.split(/\s+/)
      v.push(Number(x), Number(y), Number(z))
    } else if (line.startsWith('o ') || line.startsWith('g ')) {
      cur = line.slice(2).trim() || fallbackName
    } else if (line.startsWith('f ')) {
      const ids = line.split(/\s+/).slice(1).map(at)
      const list = groups.get(cur) ?? []
      for (let k = 1; k + 1 < ids.length; k++) list.push(ids[0], ids[k], ids[k + 1])
      groups.set(cur, list)
    }
  }
  const pos = Float32Array.from(v)
  const out: MeshPart[] = []
  for (const [name, idx] of groups) if (idx.length) out.push({ name, ...compact(pos, Uint32Array.from(idx)) })
  if (!out.length) throw new Error('OBJ: нет граней')
  return out
}

/** keep only the vertices `idx` uses */
function compact(pos: Float32Array, idx: Uint32Array): { positions: Float32Array; indices: Uint32Array } {
  const remap = new Map<number, number>()
  const out: number[] = []
  const indices = new Uint32Array(idx.length)
  for (let i = 0; i < idx.length; i++) {
    let j = remap.get(idx[i])
    if (j === undefined) {
      j = out.length / 3
      remap.set(idx[i], j)
      out.push(pos[idx[i] * 3], pos[idx[i] * 3 + 1], pos[idx[i] * 3 + 2])
    }
    indices[i] = j
  }
  return { positions: Float32Array.from(out), indices: dropDegenerate(indices) }
}

/** glTF 2.0 (.glb, or .gltf with its buffers) — meshes of TRIANGLES, the node hierarchy applied; metres → mm */
async function parseGLTF(buf: Buffer, path: string, fallbackName: string): Promise<MeshPart[]> {
  let json: any
  let bin: Buffer | null = null
  if (buf.readUInt32LE(0) === 0x46546c67) {
    let o = 12
    while (o < buf.length) {
      const len = buf.readUInt32LE(o), type = buf.readUInt32LE(o + 4)
      const chunk = buf.subarray(o + 8, o + 8 + len)
      if (type === 0x4e4f534a) json = JSON.parse(chunk.toString('utf8'))
      else if (type === 0x004e4942) bin = Buffer.from(chunk)
      o += 8 + len
    }
  } else {
    json = JSON.parse(buf.toString('utf8'))
  }
  const buffers: Buffer[] = await Promise.all((json.buffers ?? []).map(async (b: any, i: number) => {
    if (!b.uri) return bin ?? Buffer.alloc(0)
    if (b.uri.startsWith('data:')) return Buffer.from(b.uri.split(',')[1], 'base64')
    return fs.readFile(join(dirname(path), decodeURIComponent(b.uri)))
  }))
  const read = (ai: number): { data: Float64Array; comps: number } => {
    const a = json.accessors[ai]
    const bv = json.bufferViews[a.bufferView]
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type as string] ?? 1
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType as number] ?? 4
    const src = buffers[bv.buffer]
    const stride = bv.byteStride || comps * size
    const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const out = new Float64Array(a.count * comps)
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < comps; k++) {
        const o = base + i * stride + k * size
        out[i * comps + k] = a.componentType === 5126 ? src.readFloatLE(o)
          : a.componentType === 5125 ? src.readUInt32LE(o)
          : a.componentType === 5123 ? src.readUInt16LE(o)
          : a.componentType === 5121 ? src.readUInt8(o)
          : a.componentType === 5122 ? src.readInt16LE(o) : src.readInt8(o)
      }
    }
    return { data: out, comps }
  }
  // column-major 4×4 helpers
  const m4mul = (a: number[], b: number[]) => {
    const r = new Array(16).fill(0)
    for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) for (let k = 0; k < 4; k++) r[c * 4 + rr] += a[k * 4 + rr] * b[c * 4 + k]
    return r
  }
  const trs = (n: any): number[] => {
    if (n.matrix) return n.matrix
    const [tx, ty, tz] = n.translation ?? [0, 0, 0]
    const [qx, qy, qz, qw] = n.rotation ?? [0, 0, 0, 1]
    const [sx, sy, sz] = n.scale ?? [1, 1, 1]
    return [
      (1 - 2 * (qy * qy + qz * qz)) * sx, 2 * (qx * qy + qz * qw) * sx, 2 * (qx * qz - qy * qw) * sx, 0,
      2 * (qx * qy - qz * qw) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, 2 * (qy * qz + qx * qw) * sy, 0,
      2 * (qx * qz + qy * qw) * sz, 2 * (qy * qz - qx * qw) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
      tx, ty, tz, 1
    ]
  }
  const parts: MeshPart[] = []
  const visit = (ni: number, parent: number[]) => {
    const n = json.nodes[ni]
    const M = m4mul(parent, trs(n))
    if (n.mesh !== undefined) {
      const mesh = json.meshes[n.mesh]
      mesh.primitives.forEach((p: any, pi: number) => {
        if ((p.mode ?? 4) !== 4 || p.attributes?.POSITION === undefined) return
        const P = read(p.attributes.POSITION).data
        const pos = new Float32Array(P.length)
        for (let i = 0; i < P.length; i += 3) {
          const x = P[i], y = P[i + 1], z = P[i + 2]
          pos[i] = (M[0] * x + M[4] * y + M[8] * z + M[12]) * 1000
          pos[i + 1] = (M[1] * x + M[5] * y + M[9] * z + M[13]) * 1000
          pos[i + 2] = (M[2] * x + M[6] * y + M[10] * z + M[14]) * 1000
        }
        const idx = p.indices !== undefined ? Uint32Array.from(read(p.indices).data) : Uint32Array.from({ length: P.length / 3 }, (_, i) => i)
        const name = (n.name || mesh.name || fallbackName) + (mesh.primitives.length > 1 ? `-${pi + 1}` : '')
        parts.push({ name, ...weld(pos, idx) })
      })
    }
    for (const c of n.children ?? []) visit(c, M)
  }
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const scene = json.scenes?.[json.scene ?? 0]
  const roots: number[] = scene?.nodes ?? json.nodes?.map((_: unknown, i: number) => i) ?? []
  for (const r of roots) visit(r, I)
  if (!parts.length) throw new Error('glTF: нет треугольных сеток')
  return parts
}

async function parseSTEP(buf: Buffer, fallbackName: string): Promise<MeshPart[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const occt = await (require('occt-import-js') as () => Promise<any>)()
  const r = occt.ReadStepFile(new Uint8Array(buf), null)
  if (!r.success) throw new Error('STEP: файл не прочитан')
  const parts: MeshPart[] = []
  r.meshes.forEach((m: any, i: number) => {
    const pos = Float32Array.from(m.attributes.position.array as number[])
    const idx = Uint32Array.from(m.index.array as number[])
    parts.push({ name: m.name || `${fallbackName}-${i + 1}`, ...weld(pos, idx) })
  })
  if (!parts.length) throw new Error('STEP: нет тел')
  return parts
}

// ---------------------------------------------------------------- processing

async function decimate(parts: MeshPart[], budget: number): Promise<MeshPart[]> {
  const total = parts.reduce((s, p) => s + p.indices.length / 3, 0)
  if (total <= budget) return parts
  const { MeshoptSimplifier } = require('meshoptimizer') as typeof import('meshoptimizer')
  await MeshoptSimplifier.ready
  const ratio = budget / total
  return parts.map((p) => {
    const tris = p.indices.length / 3
    const target = Math.max(12, Math.floor(tris * ratio)) * 3
    if (target >= p.indices.length) return p
    // error bound relative to the part's size: 1 %, loosened if that cannot reach the budget
    let [idx] = MeshoptSimplifier.simplify(p.indices, p.positions, 3, target, 0.01)
    if (idx.length > target * 1.3) [idx] = MeshoptSimplifier.simplify(p.indices, p.positions, 3, target, 0.05)
    return { name: p.name, ...compact(p.positions, Uint32Array.from(idx)) }
  })
}

function bbox(p: Float32Array): [[number, number, number], [number, number, number]] {
  const mn: [number, number, number] = [Infinity, Infinity, Infinity]
  const mx: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p[i + k]); mx[k] = Math.max(mx[k], p[i + k]) }
  return [mn, mx]
}

/** oriented bounding box from the vertices' principal axes (Jacobi on the covariance) */
function obb(p: Float32Array): ModelInfo['parts'][number]['obbMm'] {
  const n = p.length / 3
  const c = [0, 0, 0]
  for (let i = 0; i < p.length; i += 3) { c[0] += p[i]; c[1] += p[i + 1]; c[2] += p[i + 2] }
  c[0] /= n; c[1] /= n; c[2] /= n
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < p.length; i += 3) {
    const d = [p[i] - c[0], p[i + 1] - c[1], p[i + 2] - c[2]]
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) A[r][s] += d[r] * d[s]
  }
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0
    for (let r = 0; r < 3; r++) for (let s = r + 1; s < 3; s++) off += A[r][s] * A[r][s]
    if (off < 1e-18) break
    for (let r = 0; r < 3; r++) {
      for (let s = r + 1; s < 3; s++) {
        if (Math.abs(A[r][s]) < 1e-30) continue
        const th = 0.5 * Math.atan2(2 * A[r][s], A[s][s] - A[r][r])
        const cs = Math.cos(th), sn = Math.sin(th)
        for (let k = 0; k < 3; k++) {
          const akr = A[k][r], aks = A[k][s]
          A[k][r] = cs * akr - sn * aks; A[k][s] = sn * akr + cs * aks
        }
        for (let k = 0; k < 3; k++) {
          const ark = A[r][k], ask = A[s][k]
          A[r][k] = cs * ark - sn * ask; A[s][k] = sn * ark + cs * ask
        }
        for (let k = 0; k < 3; k++) {
          const vkr = V[k][r], vks = V[k][s]
          V[k][r] = cs * vkr - sn * vks; V[k][s] = sn * vkr + cs * vks
        }
      }
    }
  }
  const axes: [number, number, number][] = [0, 1, 2].map((j) => [V[0][j], V[1][j], V[2][j]])
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const d = (p[i] - c[0]) * axes[j][0] + (p[i + 1] - c[1]) * axes[j][1] + (p[i + 2] - c[2]) * axes[j][2]
      lo[j] = Math.min(lo[j], d); hi[j] = Math.max(hi[j], d)
    }
  }
  const center: [number, number, number] = [0, 1, 2].map((k) =>
    c[k] + axes.reduce((s, ax, j) => s + ax[k] * (lo[j] + hi[j]) / 2, 0)) as [number, number, number]
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  return {
    center: center.map(r3) as [number, number, number],
    axes: axes.map((a) => a.map((x) => Math.round(x * 1e6) / 1e6) as [number, number, number]),
    half: [0, 1, 2].map((j) => r3((hi[j] - lo[j]) / 2)) as [number, number, number]
  }
}

/** GLB 2.0: one node + mesh per part, positions in METRES, uint32 indices */
export function writeGlb(parts: MeshPart[], extras: Record<string, unknown>): Buffer {
  const chunks: Buffer[] = []
  let offset = 0
  const bufferViews: any[] = [], accessors: any[] = [], meshes: any[] = [], nodes: any[] = []
  for (const p of parts) {
    const pos = new Float32Array(p.positions.length)
    for (let i = 0; i < pos.length; i++) pos[i] = p.positions[i] / 1000
    const [mn, mx] = bbox(pos)
    const pb = Buffer.from(pos.buffer, pos.byteOffset, pos.byteLength)
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: pb.length, target: 34962 })
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: pos.length / 3, type: 'VEC3', min: mn, max: mx })
    chunks.push(pb); offset += pb.length
    const ib = Buffer.from(p.indices.buffer, p.indices.byteOffset, p.indices.byteLength)
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: ib.length, target: 34963 })
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5125, count: p.indices.length, type: 'SCALAR' })
    chunks.push(ib); offset += ib.length
    meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: accessors.length - 2 }, indices: accessors.length - 1, mode: 4 }] })
    nodes.push({ name: p.name, mesh: meshes.length - 1 })
  }
  const bin = Buffer.concat(chunks)
  const gltf = {
    asset: { version: '2.0', generator: 'Kadr' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes, meshes, accessors, bufferViews,
    buffers: [{ byteLength: bin.length }],
    extras
  }
  let js = Buffer.from(JSON.stringify(gltf), 'utf8')
  if (js.length % 4) js = Buffer.concat([js, Buffer.alloc(4 - (js.length % 4), 0x20)])
  const binPad = bin.length % 4 ? Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]) : bin
  const header = Buffer.alloc(12)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + js.length + 8 + binPad.length, 8)
  const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
  const bh = Buffer.alloc(8); bh.writeUInt32LE(binPad.length, 0); bh.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jh, js, bh, binPad])
}

/**
 * A thumbnail without a GPU: flat-shaded triangles, z-buffered, from a
 * three-quarter view above the front, fitted to the frame. BGRA for
 * nativeImage; transparent background.
 */
function thumbnail(parts: MeshPart[], W = 256, H = 256): Buffer {
  const az = (-35 * Math.PI) / 180, el = (25 * Math.PI) / 180
  const ca = Math.cos(az), sa = Math.sin(az), ce = Math.cos(el), se = Math.sin(el)
  const view = (x: number, y: number, z: number): [number, number, number] => {
    const x1 = ca * x + sa * z, z1 = -sa * x + ca * z
    return [x1, ce * y - se * z1, se * y + ce * z1]
  }
  let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) {
    const [x, y] = view(p.positions[i], p.positions[i + 1], p.positions[i + 2])
    mnx = Math.min(mnx, x); mxx = Math.max(mxx, x); mny = Math.min(mny, y); mxy = Math.max(mxy, y)
  }
  const s = 0.88 * Math.min(W / Math.max(1e-6, mxx - mnx), H / Math.max(1e-6, mxy - mny))
  const cx = (mnx + mxx) / 2, cy = (mny + mxy) / 2
  const px = new Uint8Array(W * H * 4)
  const zb = new Float32Array(W * H).fill(-Infinity)
  const light = [-0.4, 0.75, 0.55]
  const ll = Math.hypot(...light)
  for (const p of parts) {
    const P = p.positions, I = p.indices
    for (let t = 0; t < I.length; t += 3) {
      const a = view(P[I[t] * 3], P[I[t] * 3 + 1], P[I[t] * 3 + 2])
      const b = view(P[I[t + 1] * 3], P[I[t + 1] * 3 + 1], P[I[t + 1] * 3 + 2])
      const c = view(P[I[t + 2] * 3], P[I[t + 2] * 3 + 1], P[I[t + 2] * 3 + 2])
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
      const nl = Math.hypot(nx, ny, nz) || 1
      nx /= nl; ny /= nl; nz /= nl
      if (nz < 0) { nx = -nx; ny = -ny; nz = -nz } // two-sided
      const lam = Math.max(0, (nx * light[0] + ny * light[1] + nz * light[2]) / ll)
      const shade = 0.28 + 0.72 * lam
      const X = [a, b, c].map((q) => (q[0] - cx) * s + W / 2)
      const Y = [a, b, c].map((q) => H / 2 - (q[1] - cy) * s)
      const Z = [a[2], b[2], c[2]]
      const x0 = Math.max(0, Math.floor(Math.min(...X))), x1 = Math.min(W - 1, Math.ceil(Math.max(...X)))
      const y0 = Math.max(0, Math.floor(Math.min(...Y))), y1 = Math.min(H - 1, Math.ceil(Math.max(...Y)))
      const den = (Y[1] - Y[2]) * (X[0] - X[2]) + (X[2] - X[1]) * (Y[0] - Y[2])
      if (Math.abs(den) < 1e-9) continue
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const w0 = ((Y[1] - Y[2]) * (x + 0.5 - X[2]) + (X[2] - X[1]) * (y + 0.5 - Y[2])) / den
          const w1 = ((Y[2] - Y[0]) * (x + 0.5 - X[2]) + (X[0] - X[2]) * (y + 0.5 - Y[2])) / den
          const w2 = 1 - w0 - w1
          if (w0 < 0 || w1 < 0 || w2 < 0) continue
          const z = w0 * Z[0] + w1 * Z[1] + w2 * Z[2]
          const k = y * W + x
          if (z <= zb[k]) continue
          zb[k] = z
          // a neutral warm grey — the model's own colours are not in these formats
          px[k * 4] = Math.round(150 * shade)     // B
          px[k * 4 + 1] = Math.round(170 * shade) // G
          px[k * 4 + 2] = Math.round(190 * shade) // R
          px[k * 4 + 3] = 255
        }
      }
    }
  }
  return nativeImage.createFromBitmap(Buffer.from(px.buffer), { width: W, height: H }).toPNG()
}

const safeName = (s: string) => s.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'model'

/** Parse any supported file into parts (mm, Y up). */
export async function readModel(path: string, opts: { upAxis?: 'y' | 'z' } = {}): Promise<{ parts: MeshPart[]; upAxis: 'y' | 'z' }> {
  const ext = extname(path).toLowerCase()
  const buf = await fs.readFile(path)
  const base = basename(path, extname(path))
  let parts: MeshPart[]
  let up: 'y' | 'z'
  switch (ext) {
    case '.stl': parts = parseSTL(buf, base); up = 'z'; break
    case '.3mf': parts = parse3MF(buf, base); up = 'z'; break
    case '.step': case '.stp': parts = await parseSTEP(buf, base); up = 'z'; break
    case '.obj': parts = parseOBJ(buf.toString('utf8'), base); up = 'y'; break
    case '.glb': case '.gltf': parts = await parseGLTF(buf, path, base); up = 'y'; break
    default: throw new Error(`формат ${ext} не поддерживается (${MODEL_EXTS.join(', ')})`)
  }
  const upAxis = opts.upAxis ?? up
  if (upAxis === 'z') for (const p of parts) zUpToYUp(p.positions)
  return { parts, upAxis }
}

/**
 * Import a model into <projectDir>/kadr-lib/models: <name>.glb (metres),
 * <name>.json (ModelInfo), <name>.png (thumbnail). `budget`: total triangles
 * kept (default 200 000).
 */
export async function importModel(path: string, projectDir: string, opts: { name?: string; budget?: number; upAxis?: 'y' | 'z' } = {}): Promise<ModelInfo> {
  if (!projectDir) throw new Error('3D-модели хранятся в папке проекта (kadr-lib/models) — сначала сохраните проект')
  const { parts: raw } = await readModel(path, { upAxis: opts.upAxis })
  const trianglesIn = raw.reduce((s, p) => s + p.indices.length / 3, 0)
  const parts = await decimate(raw, Math.max(1000, opts.budget ?? 200_000))
  const trianglesOut = parts.reduce((s, p) => s + p.indices.length / 3, 0)
  const dir = join(projectDir, 'kadr-lib', 'models')
  await fs.mkdir(dir, { recursive: true })
  let name = safeName(opts.name ?? basename(path, extname(path)))
  // never overwrite a different source's model of the same name
  for (let n = 2; existsSync(join(dir, `${name}.json`)); n++) {
    try {
      const old = JSON.parse(await fs.readFile(join(dir, `${name}.json`), 'utf8'))
      if (old.source === path) break
    } catch { break }
    name = `${safeName(opts.name ?? basename(path, extname(path)))}-${n}`
  }
  const [mn, mx] = bbox(Float32Array.from(parts.flatMap((p) => Array.from(bbox(p.positions).flat()))))
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  const info: ModelInfo = {
    name,
    source: path,
    file: `${name}.glb`,
    thumb: `${name}.png`,
    units: 'm',
    trianglesIn,
    trianglesOut,
    sizeMm: [0, 1, 2].map((k) => r3(mx[k] - mn[k])) as [number, number, number],
    parts: parts.map((p) => {
      const [a, b] = bbox(p.positions)
      return { name: p.name, triangles: p.indices.length / 3, bboxMm: [a.map(r3), b.map(r3)] as [[number, number, number], [number, number, number]], obbMm: obb(p.positions) }
    }),
    importedAt: Date.now()
  }
  const write = async (file: string, data: Buffer | string) => {
    const tmp = join(dir, `${file}.part-${process.pid}`)
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, join(dir, file))
  }
  await write(info.file, writeGlb(parts, { generator: 'Kadr', source: basename(path), units: 'm' }))
  await write(info.thumb, thumbnail(parts))
  await write(`${name}.json`, JSON.stringify(info, null, 2))
  return info
}

/** the models of a project (their descriptions), newest first */
export async function listModels(projectDir: string): Promise<(ModelInfo & { dir: string })[]> {
  const dir = join(projectDir, 'kadr-lib', 'models')
  let names: string[] = []
  try { names = await fs.readdir(dir) } catch { return [] }
  const out: (ModelInfo & { dir: string })[] = []
  for (const n of names.filter((f) => f.endsWith('.json'))) {
    try { out.push({ ...JSON.parse(await fs.readFile(join(dir, n), 'utf8')), dir }) } catch { /* not ours */ }
  }
  return out.sort((a, b) => b.importedAt - a.importedAt)
}

export function registerModelIpc() {
  ipcMain.handle('model:import', (_e, path: string, projectDir: string, opts?: { name?: string; budget?: number; upAxis?: 'y' | 'z' }) =>
    importModel(String(path), String(projectDir), opts ?? {}))
  ipcMain.handle('model:list', (_e, projectDir: string) => listModels(String(projectDir)))
}
