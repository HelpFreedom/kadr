import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, lstatSync, realpathSync, statSync } from 'fs'
import { join, sep, dirname, basename } from 'path'

// Managed by Kadr — do not edit (rewritten when Kadr updates).
//
// Layout the plugins below rely on:
//   src/fragments/<id>        a fragment; for a saved project a SYMLINK to
//                             <project>/kadr-fragments/<id>
//   src/_projects/<key>/lib   SYMLINK to <project>/kadr-lib — the project's
//                             shared code, models, fonts ('@lib/…')
//   src/_kadr/                Kadr's runtime for fragments ('@kadr/…')

// Watch the real folders behind the symlinks and replay their events on the
// symlinked path, the one the module graph knows (preserveSymlinks below).
// chokidar does not follow a symlinked folder that appears AFTER the server
// started — which is every fragment created in a saved project and every
// project's kadr-lib — so edits there were never seen: the preview kept
// serving the first transform of the file forever.
function followLinks() {
  return {
    name: 'kadr-follow-links',
    configureServer(server) {
      const dirs = () => {
        const out = []
        const frags = join(server.config.root, 'src', 'fragments')
        try { for (const n of readdirSync(frags)) out.push(join(frags, n)) } catch { /* none yet */ }
        const projects = join(server.config.root, 'src', '_projects')
        try { for (const n of readdirSync(projects)) out.push(join(projects, n, 'lib')) } catch { /* none yet */ }
        return out
      }
      // real folder → { link, ino }. A folder deleted and created again at the
      // same path (a test project, a git checkout of kadr-lib) takes its file
      // watch down with it, and a map keyed by path alone kept saying "already
      // watched" — hot reload then stopped without a word for as long as this
      // server lived (it outlives app restarts). So the watch itself is
      // checked: chokidar drops a deleted folder from getWatched(). The inode
      // alone is not enough — tmpfs hands the same number to the new folder.
      const linked = new Map()
      const scan = () => {
        let watched = null
        for (const link of dirs()) {
          try {
            if (!lstatSync(link).isSymbolicLink()) continue
            const real = realpathSync(link)
            const ino = statSync(real).ino
            const cur = linked.get(real)
            if (cur && cur.link === link && cur.ino === ino) {
              watched ??= server.watcher.getWatched()
              if (watched[real]) continue
            }
            if (cur) server.watcher.unwatch(real)
            linked.set(real, { link, ino })
            server.watcher.add(real)
          } catch { /* a dangling link: nothing to watch */ }
        }
      }
      scan()
      const timer = setInterval(scan, 1500)
      if (timer.unref) timer.unref()
      const relay = (ev) => (file) => {
        for (const [real, { link }] of linked) {
          if (file.startsWith(real + sep)) {
            server.watcher.emit(ev, link + file.slice(real.length))
            return
          }
        }
      }
      for (const ev of ['change', 'add', 'unlink']) server.watcher.on(ev, relay(ev))
    }
  }
}

/** Which project a fragment belongs to, as the key of its src/_projects
    folder — null for a fragment of an unsaved project (it lives in the
    workspace itself and has no kadr-lib). */
function projectKeyOfFragment(root, id) {
  let real
  try { real = realpathSync(join(root, 'src', 'fragments', id)) } catch { return null }
  if (basename(dirname(real)) !== 'kadr-fragments') return null
  const want = join(dirname(dirname(real)), 'kadr-lib')
  let keys = []
  try { keys = readdirSync(join(root, 'src', '_projects')) } catch { return null }
  for (const k of keys) {
    try { if (realpathSync(join(root, 'src', '_projects', k, 'lib')) === want) return k } catch { /* dangling */ }
  }
  return null
}

// '@lib/x' → the importing fragment's project, src/_projects/<key>/lib/x;
// '@kadr/x' → src/_kadr/x; 'virtual:kadr-fonts/<key>' → registers every font
// file in that project's kadr-lib/fonts (loaded by the player page before the
// fragment, see src/fragments/lazy.ts). 'remotion render' resolves the same
// names through src/_kadr/webpack.ts.
function kadrModules() {
  let root = ''
  const FONT = /\.(woff2?|ttf|otf)$/i
  return {
    name: 'kadr-modules',
    enforce: 'pre',
    configResolved(c) { root = c.root },
    async resolveId(source, importer) {
      if (source.startsWith('virtual:kadr-fonts/')) return '\0' + source
      if (source === '@kadr' || source.startsWith('@kadr/')) {
        return this.resolve(join(root, 'src', '_kadr', source.slice(6)), importer, { skipSelf: true })
      }
      if (!source.startsWith('@lib/') || !importer) return null
      const imp = importer.split('?')[0]
      const projects = join(root, 'src', '_projects') + sep
      const frags = join(root, 'src', 'fragments') + sep
      let key = null
      if (imp.startsWith(projects)) key = imp.slice(projects.length).split(sep)[0]
      else if (imp.startsWith(frags)) key = projectKeyOfFragment(root, imp.slice(frags.length).split(sep)[0])
      if (!key) {
        this.error(`'${source}': @lib works in fragments of a SAVED project (its kadr-lib folder); imported from ${imp}`)
      }
      return this.resolve(join(root, 'src', '_projects', key, 'lib', source.slice(5)), importer, { skipSelf: true })
    },
    load(id) {
      if (!id.startsWith('\0virtual:kadr-fonts/')) return null
      const key = id.slice('\0virtual:kadr-fonts/'.length)
      const dir = join(root, 'src', '_projects', key, 'lib', 'fonts')
      let files = []
      try { files = readdirSync(dir).filter((f) => FONT.test(f)).sort() } catch { /* no fonts folder */ }
      return [
        `import { loadFont, fontFromFileName } from '/src/_kadr/runtime.ts'`,
        ...files.map((f, i) => `import u${i} from '/src/_projects/${key}/lib/fonts/${f}?url'`),
        ...files.map((f, i) => `loadFont(u${i}, ...fontFromFileName(${JSON.stringify(f)}))`),
        ''
      ].join('\n')
    }
  }
}

// An edit reloads only the pages that show the edited fragment — or, for the
// project's kadr-lib, the pages of that project's fragments. By default the
// change of a module no React boundary accepts is a full reload of EVERY
// client — each fragment iframe and capture window, all of them booting again
// at once while one of them was being worked on. The player page (v3+)
// listens for 'kadr:changed' and reloads itself when the id is its own.
function hotScope() {
  return {
    name: 'kadr-hot-scope',
    enforce: 'pre',
    // parameters (defineParams): a params.json written, created or removed
    // makes that fragment's pages reload their VALUES — no page reload. Taken
    // from the watcher itself: the first save CREATES the file, and vite does
    // not pass a created file through handleHotUpdate.
    configureServer(server) {
      const frags = join(server.config.root, 'src', 'fragments') + sep
      const onParams = (file) => {
        if (!file.startsWith(frags)) return
        const parts = file.slice(frags.length).split(sep)
        if (parts.length === 2 && parts[1] === 'params.json') {
          server.ws.send({ type: 'custom', event: 'kadr:params', data: { id: parts[0] } })
        }
      }
      for (const ev of ['change', 'add', 'unlink']) server.watcher.on(ev, onParams)
    },
    handleHotUpdate({ file, server }) {
      const r = server.config.root
      const send = (id) => server.ws.send({ type: 'custom', event: 'kadr:changed', data: { id } })
      const frags = join(r, 'src', 'fragments') + sep
      const projects = join(r, 'src', '_projects') + sep
      if (file.startsWith(frags)) {
        const rest = file.slice(frags.length)
        if (!rest.includes(sep)) {
          // the registry: pages already showing their fragment don't care; one
          // still waiting for its fragment to appear reloads
          if (rest === 'index.ts' || rest === 'lazy.ts') { send('*registry'); return [] }
          return
        }
        const [fid, name] = rest.split(sep)
        // parameters: announced by the watcher above, never a reload
        if (name === 'params.json' && rest.split(sep).length === 2) return []
        send(fid)
        return []
      }
      if (file.startsWith(projects)) {
        const key = file.slice(projects.length).split(sep)[0]
        // a font added or removed changes what the fonts module registers
        const fonts = server.moduleGraph.getModuleById('\0virtual:kadr-fonts/' + key)
        if (fonts) server.moduleGraph.invalidateModule(fonts)
        let ids = []
        try { ids = readdirSync(frags) } catch { /* none */ }
        for (const id of ids) if (projectKeyOfFragment(r, id) === key) send(id)
        return []
      }
    }
  }
}

// The preview's ThreeCanvas: every import of '@remotion/three' in fragment
// code (and whatever it imports) gets src/_kadr/three-preview.tsx, which
// draws on demand at the displayed size — see that file. The wrapper itself
// imports the real package. 'remotion render' never sees this config.
function previewThree() {
  let shim = ''
  return {
    name: 'kadr-preview-three',
    enforce: 'pre',
    configResolved(c) { shim = join(c.root, 'src', '_kadr', 'three-preview.tsx') },
    resolveId(source, importer) {
      if (source !== '@remotion/three' || !importer) return null
      if (importer.split('?')[0] === shim) return null
      return shim
    }
  }
}

export default defineConfig({
  plugins: [hotScope(), kadrModules(), previewThree(), react(), followLinks()],
  clearScreen: false,
  // project-owned fragments live behind symlinks: keep module ids at the
  // symlinked (in-root) paths so the file watcher sees edits and hot reload
  // keeps working — resolved-to-realpath ids fall outside the watch root
  resolve: { preserveSymlinks: true },
  // 3D models imported from fragment code arrive as URLs, like images
  assetsInclude: ['**/*.glb', '**/*.gltf', '**/*.kdrm'],
  server: { host: '127.0.0.1', fs: { allow: ['/'] } }
})
