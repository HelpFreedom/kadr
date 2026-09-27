// The 3D importers (electron/models.ts) on real files and on synthetic ones
// with known answers — no app needed:
//   node scripts/check-models.mjs [file.3mf|stl|step|glb|obj …]
// Synthetic: a binary and an ASCII STL of the same box, a 3MF whose build item
// scales/moves an object made of a component that lives in ANOTHER model file
// of the package (the Bambu layout), Z-up → Y-up, a GLB written by Kadr read
// back at the same size, decimation keeping the bounding box. Real files given
// on the command line are imported and their sizes printed (mm), so a CAD
// model can be compared with its drawing.
import { build } from 'esbuild'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { zipSync, strToU8 } from 'fflate'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'package.json'))
// electron is stubbed: the importers only need nativeImage for the thumbnail
const out = await build({
  entryPoints: [join(root, 'electron', 'models.ts')], bundle: true, platform: 'node', format: 'cjs', write: false,
  external: ['occt-import-js', 'meshoptimizer', 'fflate'],
  alias: { '@shared': join(root, 'shared') },
  plugins: [{ name: 'stub-electron', setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'module.exports = { ipcMain: { handle() {} }, nativeImage: { createFromBitmap: () => ({ toPNG: () => Buffer.alloc(8) }) } }', loader: 'js' }))
  } }]
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require)
const M = mod.exports

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const size = (parts) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.positions[i + k]); mx[k] = Math.max(mx[k], p.positions[i + k]) }
  return { mn, mx, s: mx.map((x, k) => +(x - mn[k]).toFixed(3)) }
}
const near = (a, b, e = 1e-3) => a.every((x, i) => Math.abs(x - b[i]) <= e)
const dir = mkdtempSync(join(tmpdir(), 'kadr-models-'))

// a box 10 (x) × 20 (y) × 30 (z) mm, Z-up CAD: in Kadr (Y-up) it is 10 × 30 × 20
const box = (() => {
  const v = []
  for (const x of [0, 10]) for (const y of [0, 20]) for (const z of [0, 30]) v.push([x, y, z])
  const f = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]
  return { v, f }
})()
try {
  // ---- STL, binary and ASCII --------------------------------------------------
  {
    const bin = Buffer.alloc(84 + box.f.length * 50)
    bin.writeUInt32LE(box.f.length, 80)
    box.f.forEach((tri, i) => tri.forEach((vi, k) => box.v[vi].forEach((c, j) => bin.writeFloatLE(c, 84 + i * 50 + 12 + (k * 3 + j) * 4))))
    writeFileSync(join(dir, 'box.stl'), bin)
    const ascii = 'solid box\n' + box.f.map((tri) => `facet normal 0 0 0\nouter loop\n${tri.map((vi) => `vertex ${box.v[vi].join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n') + '\nendsolid box\n'
    writeFileSync(join(dir, 'box-ascii.stl'), ascii)
    for (const f of ['box.stl', 'box-ascii.stl']) {
      const r = await M.readModel(join(dir, f))
      const s = size(r.parts)
      check(`STL ${f}: welded (8 vertices, 12 triangles) and Y-up (10 × 30 × 20)`,
        r.parts[0].positions.length === 24 && r.parts[0].indices.length === 36 && near(s.s, [10, 30, 20]), JSON.stringify(s.s))
    }
  }
  // ---- 3MF: build item × component in another file × unit -----------------------
  {
    const meshXml = `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${box.v.map(([x, y, z]) => `<vertex x="${x / 10}" y="${y / 10}" z="${z / 10}"/>`).join('')}</vertices><triangles>${box.f.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object></resources><build/></model>`
    // component: move +5 mm in x; build item: scale ×2 and move +100 mm in x
    const mainXml = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources><object id="2" name="assembled" type="model"><components><component p:path="/3D/Objects/object_1.model" objectid="1" transform="1 0 0 0 1 0 0 0 1 5 0 0"/></components></object></resources><build><item objectid="2" transform="2 0 0 0 2 0 0 0 2 100 0 0"/></build></model>`
    writeFileSync(join(dir, 'kit.3mf'), zipSync({ '3D/3dmodel.model': strToU8(mainXml), '3D/Objects/object_1.model': strToU8(meshXml) }))
    const r = await M.readModel(join(dir, 'kit.3mf'))
    const s = size(r.parts)
    // cm → mm, then +5 x, then ×2 and +100 x: x ∈ [110, 130]; y(up) = z·2 ∈ [0, 60]; z = −y·2 ∈ [−40, 0]
    check('3MF: unit, a component in another file and the build item\'s transform, in that order',
      near(s.mn, [110, 0, -40]) && near(s.mx, [130, 60, 0]), `${JSON.stringify(s.mn)}…${JSON.stringify(s.mx)}`)
    check('3MF: the part is named after its object', r.parts[0].name === 'assembled', r.parts[0].name)
  }
  // ---- GLB written by Kadr, read back ------------------------------------------
  {
    const r = await M.readModel(join(dir, 'box.stl'))
    writeFileSync(join(dir, 'back.glb'), M.writeGlb(r.parts, {}))
    const g = await M.readModel(join(dir, 'back.glb'))
    check('GLB: written in metres, read back at the same size in mm (no axis change for glTF)',
      near(size(g.parts).s, size(r.parts).s), JSON.stringify(size(g.parts).s))
  }
  // ---- decimation keeps the shape's extent --------------------------------------
  {
    // a finely tessellated sphere, 80 000 triangles
    const N = 200, v = [], f = []
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const th = (i / N) * Math.PI, ph = (j / N) * 2 * Math.PI
      v.push(50 * Math.sin(th) * Math.cos(ph), 50 * Math.sin(th) * Math.sin(ph), 50 * Math.cos(th))
    }
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j, b = a + N + 1
      f.push(a, b, a + 1, a + 1, b, b + 1)
    }
    const pos = new Float32Array(v.length); v.forEach((x, i) => { pos[i] = x })
    const bin = Buffer.alloc(84 + (f.length / 3) * 50)
    bin.writeUInt32LE(f.length / 3, 80)
    for (let t = 0; t < f.length / 3; t++) for (let k = 0; k < 3; k++) for (let j = 0; j < 3; j++) bin.writeFloatLE(pos[f[t * 3 + k] * 3 + j], 84 + t * 50 + 12 + (k * 3 + j) * 4)
    writeFileSync(join(dir, 'sphere.stl'), bin)
    const info = await M.importModel(join(dir, 'sphere.stl'), dir, { budget: 5000 })
    check('decimation: down to the budget', info.trianglesOut <= 5000 * 1.3 && info.trianglesIn > 70000, `${info.trianglesIn} → ${info.trianglesOut}`)
    check('…keeping the extent (Ø100 mm ± 1 %)', info.sizeMm.every((x) => Math.abs(x - 100) < 1), JSON.stringify(info.sizeMm))
    check('OBB half extents of a sphere ≈ 50', info.parts[0].obbMm.half.every((h) => Math.abs(h - 50) < 1.5), JSON.stringify(info.parts[0].obbMm.half))
  }
  // ---- real files ---------------------------------------------------------------
  for (const f of process.argv.slice(2)) {
    const t0 = Date.now()
    const r = await M.readModel(f)
    const s = size(r.parts)
    const tris = r.parts.reduce((n, p) => n + p.indices.length / 3, 0)
    console.log(`INFO  ${f.split('/').pop()}: ${r.parts.length} part(s), ${tris} triangles, ${s.s.join(' × ')} mm (x, y up, z), ${Date.now() - t0} ms`)
    for (const p of r.parts.slice(0, 8)) console.log(`        ${p.name}: ${size([p]).s.join(' × ')} mm`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
