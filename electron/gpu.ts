// Which GPU Chromium renders on. On a hybrid laptop the X server runs on the
// integrated GPU, and Chromium's GL path follows it: this machine drew every
// preview — the compositor, and the three.js fragments inside their iframes —
// on the integrated Intel GPU while the discrete NVIDIA card sat idle
// (nvidia-smi: 0 processes).
//
// One Chromium has ONE GPU process, so the two cards cannot split the work;
// the choice is which one. The integrated one keeps driving the display either
// way (PRIME), and ffmpeg's VAAPI is untouched.
//
// What works, measured with a throwaway Electron on this machine:
//   --use-angle=gl-egl + __EGL_VENDOR_LIBRARY_FILENAMES=<nvidia's GLVND json>
//     → "ANGLE (NVIDIA …)" in a normal AND an offscreen window;
//   __NV_PRIME_RENDER_OFFLOAD/__GLX_VENDOR_LIBRARY_NAME (the GLX route) hung
//     the launch; the EGL vendor file alone changed nothing (ANGLE's default
//     GL backend here is GLX); --use-angle=vulkan lost WebGL2 altogether.
// It is the recipe that also puts remotion's headless Chrome on the discrete
// card, including --disable-gpu-memory-buffer-video-frames: on
// NVIDIA, video frames in GPU memory buffers broke WebGL contexts that had
// <video> textures next to them.
//
// AND THEN MEASURED, which is why 'auto' does NOT pick it. The same preview
// of a heavy 3D project (8 three.js fragments, scripts/preview-bench.mjs,
// 13–33 s), second run each so both shader caches were warm:
//                         editor worst frame   worst gap at a cut   s4 fps
//   integrated (default)         21 ms              76–160 ms          44
//   discrete via gl-egl       42–49 ms             195–236 ms          31
// The window lives on the Intel-driven X screen, so every frame drawn on the
// NVIDIA card is copied across to be shown (PRIME), and the editor has a big
// window repainting all the time. What the discrete card wins in fill rate the
// copy loses — and the preview's 3D now draws at the displayed size on demand
// (src/_kadr/three-preview in the fragment workspace), which took most of the
// fill-rate load away anyway. So: 'auto' = the default GPU; 'discrete' is a
// choice in the log panel for a machine where it measures better.
//
// Must run before app 'ready' (switches and the GPU process's environment).
// A GPU process that keeps dying, or a renderer that reports another GPU than
// the one asked for, records a fallback: the next launch uses the default.
import { app, ipcMain } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'

export type GpuPref = 'auto' | 'discrete' | 'integrated'
interface GpuFile {
  pref?: GpuPref
  /** set when discrete rendering failed; 'auto' then stays on the default */
  fallback?: { at: number; reason: string }
}

const NV_EGL = '/usr/share/glvnd/egl_vendor.d/10_nvidia.json'
const file = () => join(app.getPath('userData'), 'gpu.json')

function readFile(): GpuFile {
  try { return JSON.parse(readFileSync(file(), 'utf8')) } catch { return {} }
}
function writeFile(f: GpuFile) {
  try { writeFileSync(file(), JSON.stringify(f, null, 2)) } catch { /* read-only profile: keep defaults */ }
}

// The recipe above is X11-only: under Wayland Chromium speaks EGL to the
// compositor, NVIDIA's EGL cannot import the Intel-side buffers, and the GPU
// process dies on every start (black window). Same test as the dev launcher.
const onWayland = () =>
  !!process.env.WAYLAND_DISPLAY &&
  process.env.ELECTRON_OZONE_PLATFORM_HINT !== 'x11' &&
  !process.argv.includes('--ozone-platform=x11')

const discreteAvailable = () =>
  process.platform === 'linux' && !onWayland() && existsSync(NV_EGL) && existsSync('/proc/driver/nvidia/version')

let applied: 'discrete' | 'default' = 'default'
let why = ''
let renderer = ''

/** Decide and apply before 'ready'. */
export function applyGpuChoice() {
  const f = readFile()
  const env = process.env.KADR_GPU as GpuPref | undefined
  const pref: GpuPref = env === 'auto' || env === 'discrete' || env === 'integrated' ? env : f.pref ?? 'auto'
  if (pref === 'integrated') { why = 'выбрана встроенная'; return }
  if (!discreteAvailable()) { why = onWayland() ? 'Wayland: дискретная через EGL здесь роняет GPU-процесс' : 'дискретной видеокарты NVIDIA нет'; return }
  if (pref === 'auto') { why = 'по умолчанию: на этой машине дискретная замерена медленнее (PRIME)'; return }
  if (f.fallback) { why = `откат: ${f.fallback.reason}`; return }
  // The GPU process is forked from a zygote that exists before this code
  // runs: an environment set here never reaches it. The dev launcher
  // (electron.vite.config.ts) sets it; a packaged app relaunches itself once.
  if (process.env.__EGL_VENDOR_LIBRARY_FILENAMES !== NV_EGL) {
    if (app.isPackaged && !process.env.KADR_GPU_RELAUNCHED) {
      process.env.__EGL_VENDOR_LIBRARY_FILENAMES = NV_EGL
      process.env.KADR_GPU_RELAUNCHED = '1'
      app.relaunch()
      app.exit(0)
      return
    }
    why = 'нет __EGL_VENDOR_LIBRARY_FILENAMES при запуске — остаёмся на видеокарте по умолчанию'
    return
  }
  app.commandLine.appendSwitch('use-angle', 'gl-egl')
  app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames')
  applied = 'discrete'
  why = 'выбрана дискретная'
}

function fallBack(reason: string) {
  if (applied !== 'discrete') return
  const f = readFile()
  if (f.fallback) return
  f.fallback = { at: Date.now(), reason }
  writeFile(f)
  console.warn('[kadr] discrete GPU disabled for the next launch:', reason)
}

export function registerGpuIpc() {
  const started = Date.now()
  let crashes = 0
  app.on('child-process-gone', (_e, d) => {
    if (d.type !== 'GPU' || applied !== 'discrete') return
    crashes++
    // one crash can be anything; two in the first minutes is this setup
    if (crashes >= 2 && Date.now() - started < 5 * 60_000) {
      fallBack(`GPU-процесс падал ${crashes} раза (${d.reason})`)
    }
  })
  ipcMain.handle('gpu:get', () => {
    const f = readFile()
    return {
      pref: f.pref ?? 'auto',
      applied,
      why,
      renderer,
      available: discreteAvailable(),
      fallback: f.fallback ?? null
    }
  })
  ipcMain.handle('gpu:set', (_e, pref: unknown) => {
    if (pref !== 'auto' && pref !== 'discrete' && pref !== 'integrated') throw new Error('bad GPU preference')
    // an explicit choice also clears an old fallback — the user wants to try again
    writeFile({ pref })
    return { restartNeeded: true }
  })
  // the renderer tells us what WebGL actually runs on
  ipcMain.handle('gpu:report', (_e, name: unknown) => {
    renderer = typeof name === 'string' ? name.slice(0, 200) : ''
    if (applied === 'discrete' && renderer && !/nvidia/i.test(renderer)) {
      fallBack(`WebGL работает не на NVIDIA: ${renderer}`)
    }
    return applied
  })
}
