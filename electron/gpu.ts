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
// it to 'ok' only after the renderer actually loads.
let trialNode: string | null = null

function applyToChromium(gpu: GpuInfo): void {
  if (gpu.driver === 'nvidia') {
    // PRIME render offload. Verified on an Optimus KDE-Wayland box (glxinfo AND
    // eglinfo both report the NVIDIA GPU under exactly these vars), so Chromium's
    // EGL/GBM GPU process follows — works natively under Wayland, no need to
    // force x11. These are the same vars switcherooctl sets for the dGPU.
    // We deliberately do NOT set render-node-override: pointing Chromium's GPU
    // process at the NVIDIA node directly made it fail to init (blank window).
    process.env.__NV_PRIME_RENDER_OFFLOAD = '1'
    process.env.__GLX_VENDOR_LIBRARY_NAME = 'nvidia'
    process.env.__VK_LAYER_NV_optimus = 'NVIDIA_only'
    process.env.VK_LOADER_DRIVERS_SELECT = '*nvidia*'
  } else {
    // Intel / AMD: point Chromium's GPU process straight at the render node.
    app.commandLine.appendSwitch('render-node-override', gpu.node)
  }
  process.env.KADR_GPU_POWER = gpu.integrated ? 'low-power' : 'high-performance'
}

/**
 * Read the persisted choice and, before app 'ready', point Chromium's GPU
 * process at that render node. Must run at main module load. Never applies an
 * unproven choice twice: a 'trial' is consumed (→ 'failed') before use, so a
 * launch that never reaches the renderer heals to auto next time.
 */
export function applyGpuChoiceAtStartup(): void {
  process.env.KADR_GPU_POWER = 'default'
  const choice = readGpuChoice()
  if (!choice.node) return
  const gpu = enumerateGpus().find((g) => g.node === choice.node)
  if (!gpu) return

  if (choice.status === 'ok') {
    applyToChromium(gpu) // proven-good on a previous launch
  } else if (choice.status === 'trial') {
    writeGpuChoice({ node: gpu.node, status: 'failed' }) // heal to auto if we don't load
    trialNode = gpu.node
    applyToChromium(gpu)
  }
  // 'failed' or anything else → leave at auto (the self-heal path)
}

/** Call once the renderer has actually loaded — promotes a surviving trial to
 *  'ok' so it sticks on future launches. No-op unless this launch was a trial. */
export function confirmGpuTrial(): void {
  if (!trialNode) return
  writeGpuChoice({ node: trialNode, status: 'ok' })
  trialNode = null
}
