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
import { spawn } from 'child_process'
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

const NVIDIA_ENV = {
  __NV_PRIME_RENDER_OFFLOAD: '1',
  __GLX_VENDOR_LIBRARY_NAME: 'nvidia',
  __VK_LAYER_NV_optimus: 'NVIDIA_only'
}

/**
 * Re-exec the app on the NVIDIA GPU via PRIME render offload — the way Lutris
 * launches games: an ordinary resizable window (no gamescope), the dGPU renders
 * and the iGPU-driven display presents. The offload vars MUST be in the
 * environment from process START: Chromium forks its zygote/GPU process very
 * early, and setting the vars late in main leaves the GPU process on the iGPU
 * render node while GLX is forced to NVIDIA — that mismatch segfaults it
 * (exit_code=139, no window). So relaunch with the vars in the child's env, then
 * exit. ELECTRON_OZONE_PLATFORM_HINT=x11 routes presentation through XWayland/GLX
 * where the offload actually takes effect (native Wayland leaves EGL on the iGPU).
 */
function relaunchWithOffload(): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...NVIDIA_ENV,
    KADR_GPU_OFFLOAD: '1',
    ELECTRON_OZONE_PLATFORM_HINT: 'x11'
  }
  // load the built renderer (out/), not a dev-server URL that dies on relaunch
  delete env.ELECTRON_RENDERER_URL
  let stdio: 'ignore' | ['ignore', number, number] = 'ignore'
  try {
    // userData is per-user (not world-writable /tmp) — no symlink-attack; kept
    // for diagnosing GPU/renderer failures on the detached process
    const fd = openSync(join(app.getPath('userData'), 'gpu.log'), 'a')
    stdio = ['ignore', fd, fd]
  } catch { /* fall back to ignore */ }
  spawn(process.execPath, process.argv.slice(1), { env, detached: true, stdio }).unref()
  app.exit(0)
}

function applyGpu(gpu: GpuInfo): void {
  if (gpu.driver === 'nvidia') {
    relaunchWithOffload() // exits and re-execs with the offload env from start
    return
  }
  // Intel / AMD: point Chromium's GPU process straight at the render node.
  app.commandLine.appendSwitch('render-node-override', gpu.node)
  process.env.KADR_GPU_POWER = gpu.integrated ? 'low-power' : 'high-performance'
}

/**
 * Read the persisted choice and, before app 'ready', route rendering to it.
 * Must run at main module load. A 'trial' is consumed (→ 'failed') before use,
 * so a launch that never renders heals back to auto next time.
 */
export function applyGpuChoiceAtStartup(): void {
  process.env.KADR_GPU_POWER = 'default'
  // re-exec'd with the PRIME offload env already in the environment (from process
  // start) — Chromium is on NVIDIA; nothing to select. powerPreference stays
  // 'default' to match the working manual `__NV_PRIME… electron .` run.
  if (process.env.KADR_GPU_OFFLOAD) return

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

/** Promote a surviving trial to 'ok' (reachable only when the window renders —
 *  the Settings "Keep" button). The offload re-exec sets trialNode in the outer
 *  process which then exits, so fall back to the on-disk choice. */
export function confirmGpuTrial(): void {
  const node = trialNode ?? readGpuChoice().node
  if (!node) return
  writeGpuChoice({ node, status: 'ok' })
  trialNode = null
}

/** Env for the fresh process a GPU switch relaunches into: clears the NVIDIA
 *  offload vars / x11 hint (so switching back to Intel goes native Wayland on the
 *  iGPU) and ELECTRON_RENDERER_URL (a switch may relaunch from a now-dead dev
 *  server — load the built out/ instead). */
export function cleanRelaunchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of [
    'KADR_GPU_OFFLOAD', 'ELECTRON_OZONE_PLATFORM_HINT',
    '__NV_PRIME_RENDER_OFFLOAD', '__GLX_VENDOR_LIBRARY_NAME', '__VK_LAYER_NV_optimus',
    'ELECTRON_RENDERER_URL'
  ]) delete env[k]
  return env
}
