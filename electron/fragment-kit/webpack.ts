// Kadr's part of the webpack config for 'remotion render' (used by
// kadr.remotion.config.ts). Managed by Kadr — do not edit.
//
// * symlinks:false — project-owned fragments are symlinks into src/fragments;
//   webpack's default resolves them to the project folder, where there is no
//   node_modules, and three/@remotion/three stop resolving. The preview's vite
//   does the same (preserveSymlinks).
// * '@lib/…' — the project's own shared code, <project>/kadr-lib, reached
//   through src/_projects/<key>/lib. Which project is decided by the file
//   that imports it, exactly as in the preview (vite.config.ts), so one
//   config serves every project and the webpack cache is not split per
//   project.
// * '@kadr/…' — Kadr's runtime for fragments (src/_kadr).
// * 3D models are files the page fetches (asset/resource).
import { readdirSync, realpathSync } from 'fs'
import { join, dirname, basename, sep } from 'path'

export function kadrWebpack(ws: string) {
  const frags = join(ws, 'src', 'fragments')
  const projects = join(ws, 'src', '_projects')
  /** the lib folder (inside the workspace) serving the module in `dir` */
  const libFor = (dir: string): string | null => {
    const inProject = dir.startsWith(projects + sep) ? dir.slice(projects.length + 1).split(sep)[0] : null
    if (inProject) return join(projects, inProject, 'lib')
    if (!dir.startsWith(frags + sep)) return null
    const id = dir.slice(frags.length + 1).split(sep)[0]
    let real: string
    try { real = realpathSync(join(frags, id)) } catch { return null }
    if (basename(dirname(real)) !== 'kadr-fragments') return null
    const want = join(dirname(dirname(real)), 'kadr-lib')
    let keys: string[] = []
    try { keys = readdirSync(projects) } catch { return null }
    for (const k of keys) {
      try { if (realpathSync(join(projects, k, 'lib')) === want) return join(projects, k, 'lib') } catch { /* dangling */ }
    }
    return null
  }
  class KadrResolve {
    apply(resolver: any) {
      const target = resolver.ensureHook('resolve')
      resolver.getHook('described-resolve').tapAsync('KadrResolve', (req: any, ctx: any, cb: any) => {
        const r = req.request
        if (typeof r !== 'string') return cb()
        let to: string | null = null
        if (r.startsWith('@lib/')) {
          const lib = libFor(req.path)
          if (!lib) return cb(new Error(`'${r}': @lib works in fragments of a SAVED project (its kadr-lib folder); imported from ${req.path}`))
          to = join(lib, r.slice(5))
        } else if (r === '@kadr' || r.startsWith('@kadr/')) {
          to = join(ws, 'src', '_kadr', r.slice(6))
        }
        if (!to) return cb()
        resolver.doResolve(target, { ...req, request: to }, `kadr: ${r}`, ctx, cb)
      })
    }
  }
  return (config: any) => ({
    ...config,
    resolve: {
      ...config.resolve,
      symlinks: false,
      plugins: [...(config.resolve?.plugins ?? []), new KadrResolve()]
    },
    module: {
      ...config.module,
      rules: [...(config.module?.rules ?? []), { test: /\.(glb|gltf|kdrm)$/, type: 'asset/resource' }]
    }
  })
}
