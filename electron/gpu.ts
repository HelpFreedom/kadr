// GPU selection. Which physical GPU Chromium's GPU process uses is decided
// ONCE at startup (before app 'ready'), so the user's choice is persisted to
// userData/gpu.json and re-applied here on every launch; changing it needs an
// app relaunch. On this Optimus-style laptop the default is the integrated
// Intel iGPU — forcing the discrete GPU speeds up the WebGL compositor (preview
// + the offline export composite), though the final H.264 encode stays on x264.
//
// SAFETY: a bad choice (e.g. NVIDIA that won't come up under this compositor)
// must never brick the app. A newly-picked GPU is applied as a 'trial': the
// file is flipped to 'failed' BEFORE the window is created, and only flipped to
// 'ok' once the renderer actually finishes loading (confirmGpuTrial, wired to
// did-finish-load). So if the trial launch shows no window, the NEXT launch
// sees 'failed' and reverts to auto — the app heals itself.
import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { readdirSync, openSync } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import type { GpuInfo } from '@shared/types'

const VENDOR_NAME: Record<string, string> = {
  '0x10de': 'NVIDIA',
  '0x8086': 'Intel',
  '0x1002': 'AMD',
  '0x1022': 'AMD'
}

export type GpuStatus = 'trial' | 'ok' | 'failed'
export interface GpuChoice {
  node?: string // /dev/dri/renderD129 ; absent/empty = auto (no override)
  status?: GpuStatus
}

// same file the renderer writes via writeUserStore('gpu', …) — see main's
// userStorePath(): userData/<name>.json
const gpuStorePath = () => join(app.getPath('userData'), 'gpu.json')

export function readGpuChoice(): GpuChoice {
  try {
    return JSON.parse(readFileSync(gpuStorePath(), 'utf8')) as GpuChoice
  } catch {
    return {}
  }
}

function writeGpuChoice(c: GpuChoice): void {
  try {
    writeFileSync(gpuStorePath(), JSON.stringify(c, null, 1))
  } catch {
    /* best effort; a read failure next launch just falls back to auto */
  }
}

/** Enumerate DRM render nodes into user-choosable GPUs (Linux only). */
export function enumerateGpus(): GpuInfo[] {
  let nodes: string[]
  try {
    nodes = readdirSync('/dev/dri').filter((n) => /^renderD\d+$/.test(n))
  } catch {
    return []
  }
  const read = (base: string, f: string) => {
    try {
      return readFileSync(join(base, f), 'utf8').trim()
    } catch {
      return ''
    }
  }
  return nodes.sort().map((n) => {
    const base = `/sys/class/drm/${n}/device`
    const vendorId = read(base, 'vendor')
    const deviceId = read(base, 'device')
    const driver = read(base, 'uevent').match(/DRIVER=(\S+)/)?.[1] ?? ''
    // boot_vga=1 marks the primary display adapter — the integrated GPU on
    // laptops. Absent (0/missing) plus a discrete driver ⇒ the dGPU.
    const integrated = read(base, 'boot_vga') === '1' || driver === 'i915'
    return {
      node: `/dev/dri/${n}`,
      driver,
      vendorId,
      deviceId,
      vendor: VENDOR_NAME[vendorId] ?? driver ?? 'GPU',
      integrated
    }
  })
}

// set when THIS launch applied a not-yet-proven GPU; confirmGpuTrial() promotes
// it to 'ok' only after the user confirms the window renders.
let trialNode: string | null = null

const hasGamescope = (): boolean => {
  try {
    return spawnSync('sh', ['-c', 'command -v gamescope'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

const NVIDIA_ENV = {
  __NV_PRIME_RENDER_OFFLOAD: '1',
  __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
  __VK_LAYER_NV_optimus: 'NVIDIA_only'
}

/**
 * Re-launch this app inside gamescope on the NVIDIA GPU, then exit. gamescope
 * renders the app on the dGPU and hands finished frames to the desktop
 * compositor (kwin, on the iGPU) — the same path games use, and the only one
 * that reliably shows a window on this hybrid Wayland setup (native Wayland goes
 * blank; XWayland offload crashes the GPU process → no window). The nested
 * WAYLAND/DISPLAY are stashed so a later switch back to Intel can escape.
 */
function relaunchInGamescope(): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...NVIDIA_ENV,
    KADR_GAMESCOPE: '1',
    KADR_HOST_WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY ?? '',
    KADR_HOST_DISPLAY: process.env.DISPLAY ?? ''
  }
  // the re-exec'd app must load the built renderer (out/), not a dev server URL
  // that dies when electron-vite's electron exits — else it's a blank window
  delete env.ELECTRON_RENDERER_URL
  const args = ['-W', '1600', '-H', '900', '--', process.execPath, ...process.argv.slice(1)]
  // capture gamescope + the inner app's output so GPU/renderer failures are
  // diagnosable (the process is detached, so there's no terminal to inherit)
  let stdio: 'ignore' | ['ignore', number, number] = 'ignore'
  try {
    const fd = openSync(join(tmpdir(), 'kadr-gpu.log'), 'a')
    stdio = ['ignore', fd, fd]
  } catch { /* fall back to ignore */ }
  spawn('gamescope', args, { env, detached: true, stdio }).unref()
  app.exit(0)
}

function applyGpu(gpu: GpuInfo): void {
  if (gpu.driver === 'nvidia') {
    if (hasGamescope()) {
      relaunchInGamescope() // exits and re-enters inside gamescope
      return
    }
    // no gamescope: best-effort XWayland offload (may still not present)
    app.commandLine.appendSwitch('ozone-platform', 'x11')
    app.commandLine.appendSwitch('disable-gpu-sandbox')
    Object.assign(process.env, NVIDIA_ENV)
  } else {
    // Intel / AMD: point Chromium's GPU process straight at the render node.
    app.commandLine.appendSwitch('render-node-override', gpu.node)
  }
  process.env.KADR_GPU_POWER = gpu.integrated ? 'low-power' : 'high-performance'
}

/**
 * Read the persisted choice and, before app 'ready', route rendering to it.
 * Must run at main module load. A 'trial' is consumed (→ 'failed') before use,
 * so a launch that never renders heals back to auto next time.
 */
export function applyGpuChoiceAtStartup(): void {
  process.env.KADR_GPU_POWER = 'default'
  // already relaunched inside gamescope on the dGPU (offload env inherited) —
  // Chromium is on NVIDIA, nothing to select. Leave powerPreference at 'default':
  // a 'high-performance' request makes Chromium re-pick a GPU and blanks the
  // window inside gamescope's single-GPU view (this exactly matches the working
  // manual `gamescope -- electron .` run).
  if (process.env.KADR_GAMESCOPE) return

  const choice = readGpuChoice()
  if (!choice.node) return
  const gpu = enumerateGpus().find((g) => g.node === choice.node)
  if (!gpu) return

  if (choice.status === 'ok') {
    applyGpu(gpu) // proven-good on a previous launch
  } else if (choice.status === 'trial') {
    writeGpuChoice({ node: gpu.node, status: 'failed' }) // heal to auto if it never renders
    trialNode = gpu.node
    applyGpu(gpu)
  }
  // 'failed' or anything else → leave at auto (the self-heal path)
}

/** Promote a surviving trial to 'ok' (only reachable when the window renders —
 *  see the Settings "Keep" button). Inside gamescope the outer process that set
 *  trialNode has exited, so fall back to the on-disk choice. */
export function confirmGpuTrial(): void {
  const node = trialNode ?? readGpuChoice().node
  if (!node) return
  writeGpuChoice({ node, status: 'ok' })
  trialNode = null
}

/** Env for relaunching as a fresh top-level process on the real desktop —
 *  escapes gamescope's nested Wayland and clears the NVIDIA offload vars, so the
 *  new process re-decides the GPU from gpu.json cleanly. */
export function cleanRelaunchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (env.KADR_HOST_WAYLAND_DISPLAY !== undefined) env.WAYLAND_DISPLAY = env.KADR_HOST_WAYLAND_DISPLAY
  if (env.KADR_HOST_DISPLAY !== undefined) env.DISPLAY = env.KADR_HOST_DISPLAY
  for (const k of [
    'KADR_GAMESCOPE', 'KADR_HOST_WAYLAND_DISPLAY', 'KADR_HOST_DISPLAY',
    '__NV_PRIME_RENDER_OFFLOAD', '__GLX_VENDOR_LIBRARY_NAME', '__VK_LAYER_NV_optimus',
    // a GPU switch relaunches from a possibly-dead dev server; load built out/
    'ELECTRON_RENDERER_URL'
  ]) delete env[k]
  return env
}
