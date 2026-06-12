// Remotion fragments backend: one shared workspace (~/kadr-fragments) holds
// every fragment composition as a small TSX module. A vite dev server gives
// the editor's preview a live, hot-reloading Player page (no renders during
// iteration); `remotion render` runs exactly once per fragment content hash
// at export time.
import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { promises as fs, existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { homedir } from 'os'
import type { FragmentSpec, FragmentInfo } from '@shared/types'

export const WORKSPACE = process.env.KADR_FRAGMENTS_DIR || join(homedir(), 'kadr-fragments')
const FRAG_DIR = () => join(WORKSPACE, 'src', 'fragments')

// npm install and remotion's headless-chrome download may need the user's
// network settings (proxies etc.) — shared with the Claude session config:
// userData/claude-env.json { "env": { "HTTPS_PROXY": "...", ... } }
async function netEnv(): Promise<Record<string, string>> {
  try {
    const p = join(app.getPath('userData'), 'claude-env.json')
    const cfg = JSON.parse(await fs.readFile(p, 'utf8'))
    return cfg?.env ?? {}
  } catch {
    return {}
  }
}

// ------------------------------------------------------------- scaffolding

const PKG_JSON = `{
  "name": "kadr-fragments",
  "private": true,
  "description": "Kadr video editor: Remotion fragment compositions (managed; src/fragments/* are yours)",
  "dependencies": {
    "@remotion/cli": "4.0.247",
    "@remotion/player": "4.0.247",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "remotion": "4.0.247"
  },
  "devDependencies": {
    "@types/react": "18.3.3",
    "@vitejs/plugin-react": "4.3.1",
    "typescript": "5.5.4",
    "vite": "5.4.8"
  }
}
`

const VITE_CONFIG = `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: '127.0.0.1', fs: { allow: ['/'] } }
})
`

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": false,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "esModuleInterop": true,
    "noEmit": true
  },
  "include": ["src", "player.tsx"]
}
`

const INDEX_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
      #root { width: 100vw; height: 100vh; }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/player.tsx"></script>
  </body>
</html>
`

const PLAYER_TSX = `// Kadr player page: mounts one fragment in @remotion/player and obeys
// sync messages from the editor. Managed by Kadr — do not edit.
import React, { useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { Player, PlayerRef } from '@remotion/player'
import { fragments } from './src/fragments'

function App() {
  const id = new URLSearchParams(location.search).get('comp') || ''
  const entry = (fragments as Record<string, any>)[id]
  const ref = useRef<PlayerRef>(null)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = e.data
      const p = ref.current
      if (!m || m.kadr !== true || !p) return
      if (m.type === 'sync') {
        const cur = p.getCurrentFrame()
        if (typeof m.volume === 'number') {
          p.setVolume(Math.max(0, Math.min(1, m.volume)))
          if (m.volume <= 0.001) p.mute()
          else p.unmute()
        }
        if (!m.playing) {
          if (p.isPlaying()) p.pause()
          if (cur !== m.frame) p.seekTo(m.frame)
        } else {
          if (Math.abs(cur - m.frame) > 3) p.seekTo(m.frame)
          if (!p.isPlaying()) p.play()
        }
      }
    }
    window.addEventListener('message', onMsg)
    parent.postMessage({ kadr: true, type: 'ready', comp: id }, '*')
    return () => window.removeEventListener('message', onMsg)
  }, [])
  if (!entry) {
    return React.createElement('div',
      { style: { color: '#f66', fontFamily: 'monospace', padding: 20 } },
      'unknown composition: ' + id)
  }
  return React.createElement(Player, {
    ref,
    component: entry.component,
    durationInFrames: entry.meta.durationInFrames,
    compositionWidth: entry.meta.width,
    compositionHeight: entry.meta.height,
    fps: entry.meta.fps,
    style: { width: '100vw', height: '100vh' },
    controls: false,
    clickToPlay: false,
    doubleClickToFullscreen: false,
    spaceKeyToPlayOrPause: false,
    acknowledgeRemotionLicense: true
  })
}
createRoot(document.getElementById('root')!).render(React.createElement(App))
`

const ROOT_TSX = `// Compositions for \`remotion render\` — derived from the registry.
// Managed by Kadr — do not edit.
import React from 'react'
import { Composition } from 'remotion'
import { fragments } from './fragments'

export const Root: React.FC = () => (
  <>
    {Object.entries(fragments).map(([id, f]) => (
      <Composition
        key={id}
        id={id}
        component={f.component as React.FC}
        durationInFrames={f.meta.durationInFrames}
        fps={f.meta.fps}
        width={f.meta.width}
        height={f.meta.height}
      />
    ))}
  </>
)
`

const INDEX_TS = `import { registerRoot } from 'remotion'
import { Root } from './Root'
registerRoot(Root)
`

const fragmentTemplate = (name: string) => `import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion'
import meta from './meta.json'

// «${name}» — Kadr fragment. Edit freely: the editor preview hot-reloads.
// meta.json (width/height/fps/durationInFrames) is the single source of
// truth for timing; keep it in sync if you change the duration.

const Frag: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps, durationInFrames } = useVideoConfig()
  const appear = spring({ frame, fps, config: { damping: 14 } })
  const fade = interpolate(frame, [durationInFrames - Math.min(20, durationInFrames / 4), durationInFrames], [1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp'
  })
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', opacity: fade }}>
      <div
        style={{
          fontFamily: 'sans-serif',
          fontSize: 90,
          fontWeight: 700,
          color: 'white',
          textShadow: '0 4px 30px rgba(0,0,0,0.6)',
          transform: \`scale(\${appear})\`
        }}
      >
        ${name}
      </div>
    </AbsoluteFill>
  )
}

export const fragment = { component: Frag, meta }
`

async function writeIfMissing(path: string, content: string) {
  try {
    await fs.access(path)
  } catch {
    await fs.writeFile(path, content)
  }
}

/** Rewrite the registry from the folders actually present on disk. */
async function regenRegistry() {
  const dirs = (await fs.readdir(FRAG_DIR(), { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => existsSync(join(FRAG_DIR(), n, 'index.tsx')))
    .sort()
  const lines = [
    '// AUTO-GENERATED by Kadr — fragment registry. Do not edit.',
    ...dirs.map((d, i) => `import { fragment as f${i} } from './${d}'`),
    '',
    'export const fragments = {',
    ...dirs.map((d, i) => `  '${d}': f${i},`),
    '}',
    ''
  ]
  await fs.writeFile(join(FRAG_DIR(), 'index.ts'), lines.join('\n'))
}

async function ensureWorkspace(
  onProgress?: (phase: string, p: number) => void
): Promise<{ dir: string; installed: boolean }> {
  await fs.mkdir(FRAG_DIR(), { recursive: true })
  await writeIfMissing(join(WORKSPACE, 'package.json'), PKG_JSON)
  await writeIfMissing(join(WORKSPACE, 'vite.config.ts'), VITE_CONFIG)
  await writeIfMissing(join(WORKSPACE, 'tsconfig.json'), TSCONFIG)
  await writeIfMissing(join(WORKSPACE, 'index.html'), INDEX_HTML)
  await writeIfMissing(join(WORKSPACE, 'player.tsx'), PLAYER_TSX)
  await writeIfMissing(join(WORKSPACE, 'src', 'Root.tsx'), ROOT_TSX)
  await writeIfMissing(join(WORKSPACE, 'src', 'index.ts'), INDEX_TS)
  if (!existsSync(join(FRAG_DIR(), 'index.ts'))) await regenRegistry()

  let installed = false
  if (!existsSync(join(WORKSPACE, 'node_modules', 'remotion'))) {
    onProgress?.('install', 0)
    const extraEnv = await netEnv()
    await new Promise<void>((resolve, reject) => {
      const child = spawn('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: WORKSPACE,
        env: { ...process.env, ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let err = ''
      child.stderr.on('data', (c) => { err += c })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`npm install failed (${code}): ${err.slice(-600)}`))
      })
    })
    installed = true
    onProgress?.('install', 1)
  }
  return { dir: WORKSPACE, installed }
}

// --------------------------------------------------------------- dev server

let server: { child: ChildProcess | null; url: string } | null = null
const VITE_PORT = 5621

/** A server (possibly from a previous app run) already serving the page? */
async function probeExisting(): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${VITE_PORT}/`, {
      signal: AbortSignal.timeout(1500)
    })
    const body = await res.text()
    if (res.ok && body.includes('player.tsx')) return `http://127.0.0.1:${VITE_PORT}`
  } catch { /* nothing there */ }
  return null
}

async function ensureServer(): Promise<{ url: string }> {
  if (server && (!server.child || server.child.exitCode === null)) return { url: server.url }
  server = null
  await ensureWorkspace()
  const existing = await probeExisting()
  if (existing) {
    server = { child: null, url: existing }
    return { url: existing }
  }
  // a watchdog shell kills vite when this process dies — orphaned children
  // inherit Electron's listening sockets and would block the next launch.
  // The bin runs directly (NOT via npx — npx makes vite a grandchild the
  // watchdog's kill couldn't reach).
  const child = spawn('sh', ['-c',
    `"./node_modules/.bin/vite" --port ${VITE_PORT} --strictPort & V=$!; ` +
    `(while kill -0 ${process.pid} 2>/dev/null; do sleep 3; done; kill $V 2>/dev/null) & ` +
    'wait $V'
  ], {
    cwd: WORKSPACE,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const url = await new Promise<string>((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error('vite start timeout: ' + out.slice(-400))), 30000)
    const onData = (c: Buffer) => {
      out += c
      const m = out.match(/(http:\/\/127\.0\.0\.1:\d+)/)
      if (m) {
        clearTimeout(timer)
        resolve(m[1])
      }
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => { clearTimeout(timer); reject(new Error(`vite exited ${code}: ${out.slice(-400)}`)) })
  })
  server = { child, url }
  return { url }
}

function stopServer() {
  server?.child?.kill()
  server = null
}

// ------------------------------------------------------------ create/render

const slug = (s: string) =>
  s.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'frag'

async function createFragment(spec: FragmentSpec): Promise<FragmentInfo> {
  await ensureWorkspace()
  const id = `${slug(spec.name)}-${Math.random().toString(36).slice(2, 7)}`
  const dir = join(FRAG_DIR(), id)
  await fs.mkdir(dir, { recursive: true })
  const meta = {
    id,
    name: spec.name,
    width: Math.round(spec.width),
    height: Math.round(spec.height),
    fps: Math.max(60, Math.round(spec.fps)),
    durationInFrames: Math.max(1, Math.round(spec.durationInFrames)),
    transparent: !!spec.transparent
  }
  await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  await fs.writeFile(join(dir, 'index.tsx'), fragmentTemplate(spec.name))
  await regenRegistry()
  return { id, dir, entry: join(dir, 'index.tsx'), meta: meta as unknown as FragmentSpec }
}

async function deleteFragment(id: string): Promise<void> {
  const dir = join(FRAG_DIR(), id)
  // refuse anything that is not a direct child of the fragments dir
  if (!id || id.includes('/') || id.includes('..')) throw new Error('bad fragment id')
  await fs.rm(dir, { recursive: true, force: true })
  await regenRegistry()
}

/** Content hash of a fragment folder (names + mtimes + sizes). */
function fragmentHash(id: string): string {
  const h = createHash('sha1')
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules') continue
      const p = join(dir, name)
      const st = statSync(p)
      h.update(`${name}:${st.size}:${Math.round(st.mtimeMs)};`)
      if (st.isDirectory()) walk(p)
    }
  }
  walk(join(FRAG_DIR(), id))
  return h.digest('hex').slice(0, 16)
}

const renderDir = () => join(app.getPath('userData'), 'fragment-renders')
let renderChain: Promise<unknown> = Promise.resolve()

async function renderFragment(
  id: string,
  opts: { transparent?: boolean } | undefined,
  onProgress: (p: number) => void
): Promise<{ path: string; cached: boolean }> {
  await ensureWorkspace()
  let transparent = !!opts?.transparent
  try {
    const meta = JSON.parse(await fs.readFile(join(FRAG_DIR(), id, 'meta.json'), 'utf8'))
    if (opts?.transparent === undefined) transparent = !!meta.transparent
  } catch { /* meta is optional for the decision */ }
  const ext = transparent ? 'webm' : 'mp4'
  const out = join(renderDir(), `${id}-${fragmentHash(id)}${transparent ? '-a' : ''}.${ext}`)
  try {
    await fs.access(out)
    return { path: out, cached: true } // exact content already rendered
  } catch { /* not yet */ }
  await fs.mkdir(renderDir(), { recursive: true })

  const args = ['remotion', 'render', 'src/index.ts', id, out, '--log=error']
  if (transparent) args.push('--codec=vp8', '--pixel-format=yuva420p', '--image-format=png')
  else args.push('--codec=h264')

  const extraEnv = await netEnv()
  const job = renderChain.then(() => new Promise<void>((resolve, reject) => {
    const child = spawn('npx', args, {
      cwd: WORKSPACE,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let all = ''
    const onData = (c: Buffer) => {
      all += c
      // remotion prints e.g. "Rendered 120/300"
      const m = all.match(/Rendered (\d+)\/(\d+)(?![\s\S]*Rendered \d+\/\d+)/)
      if (m) onProgress(Math.min(0.99, Number(m[1]) / Math.max(1, Number(m[2]))))
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`remotion render exited ${code}: ${all.slice(-800)}`))
    })
  }))
  renderChain = job.catch(() => { /* keep the queue alive */ })
  await job
  onProgress(1)
  return { path: out, cached: false }
}

// ------------------------------------------------------------ pixel capture
// When a fragment clip carries GL-only features (masks, 3D, transitions,
// effects), the preview swaps its iframe for true pixels: a hidden offscreen
// window runs the same Player page and streams BGRA frames to the renderer,
// where the fragment becomes a regular compositor layer.

const captures = new Map<string, BrowserWindow>()

async function captureStart(
  getWin: () => BrowserWindow | null,
  id: string,
  url: string,
  w: number,
  h: number,
  fps: number
): Promise<void> {
  if (captures.has(id)) return
  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    width: Math.max(64, Math.round(w)),
    height: Math.max(36, Math.round(h)),
    webPreferences: { offscreen: true }
  })
  captures.set(id, win)
  win.webContents.setFrameRate(Math.max(10, Math.min(60, Math.round(fps))))
  win.webContents.on('paint', (_ev, _dirty, image) => {
    const size = image.getSize()
    // BGRA, premultiplied — the compositor shader undoes both
    getWin()?.webContents.send('fragment:frame', {
      id, w: size.width, h: size.height, data: image.getBitmap()
    })
  })
  await win.loadURL(url)
}

function captureStop(id: string) {
  const win = captures.get(id)
  captures.delete(id)
  if (win && !win.isDestroyed()) win.destroy()
}

function captureSync(id: string, msg: unknown) {
  const win = captures.get(id)
  if (!win || win.isDestroyed()) return
  win.webContents
    .executeJavaScript(`window.postMessage(${JSON.stringify(msg)}, '*'); 0`, true)
    .catch(() => { /* page mid-load */ })
}

function stopAllCaptures() {
  for (const id of [...captures.keys()]) captureStop(id)
}

// ---------------------------------------------------------------------- IPC

export function registerFragmentIpc(getWin: () => BrowserWindow | null) {
  const send = (id: string, phase: string, progress: number) =>
    getWin()?.webContents.send('fragment:progress', { id, phase, progress })

  ipcMain.handle('fragment:ensure', () =>
    ensureWorkspace((phase, p) => send('workspace', phase, p))
  )
  ipcMain.handle('fragment:server', () => ensureServer())
  ipcMain.handle('fragment:create', (_e, spec: FragmentSpec) => createFragment(spec))
  ipcMain.handle('fragment:delete', (_e, id: string) => deleteFragment(id))
  ipcMain.handle('fragment:render', (_e, id: string, opts?: { transparent?: boolean }) =>
    renderFragment(id, opts, (p) => send(id, 'render', p))
  )
  ipcMain.handle('fragment:capture-start', (_e, id: string, url: string, w: number, h: number, fps: number) =>
    captureStart(getWin, id, url, w, h, fps)
  )
  ipcMain.handle('fragment:capture-stop', (_e, id: string) => captureStop(id))
  ipcMain.on('fragment:capture-sync', (_e, id: string, msg: unknown) => captureSync(id, msg))
  app.on('before-quit', () => {
    stopServer()
    stopAllCaptures()
  })
}
