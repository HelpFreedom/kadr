// Will Chromium draw this Electron window through Wayland? Pure, so the dev
// launcher (electron.vite.config.ts, before Electron exists), main
// (electron/gpu.ts) and a node check (scripts/check-ozone.mjs) all ask the
// same question.
//
// Why it matters (HelpFreedom/kadr#44, reproduced on this machine — Intel +
// NVIDIA, a Wayland session): the discrete-GPU recipe in gpu.ts puts NVIDIA's
// EGL vendor into the environment. Under X11 that changes nothing until
// gl-egl is asked for. Under Wayland Chromium itself talks to the compositor
// through EGL, NVIDIA's EGL cannot import the buffers of the Intel card that
// drives the screen («eglCreateImage failed with 0x3004»), the GPU process
// dies over and over, WebGL2 is gone and the window stays black.
//
// Electron (≥ 38) picks the platform by itself — Wayland when a Wayland
// display is there — unless X11 is forced on the command line or through
// ELECTRON_OZONE_PLATFORM_HINT. When unsure, the answer is "Wayland": that
// only withholds the discrete card, which is never the default anyway.
export function waylandWindow(env: Record<string, string | undefined>, argv: readonly string[]): boolean {
  for (const a of argv) {
    const m = /^--ozone-platform(?:-hint)?=(.+)$/.exec(a)
    if (m) {
      const v = m[1].toLowerCase()
      if (v === 'x11') return false
      if (v === 'wayland') return true
    }
  }
  const hint = env.ELECTRON_OZONE_PLATFORM_HINT?.toLowerCase()
  if (hint === 'x11') return false
  if (hint === 'wayland') return true
  return !!env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === 'wayland'
}
