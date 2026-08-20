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
import { readdirSync } from 'fs'
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

function applyGpu(gpu: GpuInfo): void {
  if (gpu.driver === 'nvidia') {
    // NVIDIA PRIME render offload in a normal window — exactly how Lutris runs
    // games: the dGPU renders (source), the iGPU-driven display presents it
    // (sink). Needs the XWayland/GLX path (--ozone-platform=x11) for the offload
    // env to take effect; native Wayland leaves Chromium's EGL on the iGPU.
    app.commandLine.appendSwitch('ozone-platform', 'x11')
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
 *  the Settings "Keep" button); a bad pick that never renders stays 'failed' and
 *  heals to auto on the next launch. */
export function confirmGpuTrial(): void {
  const node = trialNode ?? readGpuChoice().node
  if (!node) return
  writeGpuChoice({ node, status: 'ok' })
  trialNode = null
}

/** Env for the fresh process a GPU switch relaunches into: clears the NVIDIA
 *  offload vars (so switching back to Intel doesn't inherit them) and
 *  ELECTRON_RENDERER_URL (the switch may relaunch from a now-dead dev server —
 *  load the built out/ instead). */
export function cleanRelaunchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of [
    '__NV_PRIME_RENDER_OFFLOAD', '__GLX_VENDOR_LIBRARY_NAME', '__VK_LAYER_NV_optimus',
    'ELECTRON_RENDERER_URL'
  ]) delete env[k]
  return env
}
