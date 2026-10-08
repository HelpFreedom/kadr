import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { existsSync } from 'fs'

// Electron's GPU process is forked from a zygote that starts BEFORE main.ts
// runs, so the EGL vendor for the discrete GPU (electron/gpu.ts) has to be in
// the environment the app is launched with — and this file runs in exactly
// that process. Under X11 the variable alone changes nothing (Chromium's
// default GL backend there is GLX); it only matters once gpu.ts asks for
// gl-egl. UNDER WAYLAND IT IS FATAL: Chromium talks EGL to the compositor
// there, the variable hands all of EGL to NVIDIA while the screen is on the
// Intel card, and importing the compositor's buffers fails («eglCreateImage
// failed with 0x3004») — the GPU process dies three times and the window
// stays black. So it is set only for an X11 window (gpu.ts agrees: no
// discrete choice on Wayland).
const NV_EGL = '/usr/share/glvnd/egl_vendor.d/10_nvidia.json'
const onWayland =
  !!process.env.WAYLAND_DISPLAY &&
  process.env.ELECTRON_OZONE_PLATFORM_HINT !== 'x11' &&
  !process.argv.includes('--ozone-platform=x11')
if (process.platform === 'linux' && !onWayland && existsSync(NV_EGL) && !process.env.__EGL_VENDOR_LIBRARY_FILENAMES) {
  process.env.__EGL_VENDOR_LIBRARY_FILENAMES = NV_EGL
}

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: 'electron/main.ts' },
      // node-pty is a native module — must stay a runtime require; the 3D
      // importers load WebAssembly next to their own files (electron/models.ts)
      rollupOptions: { external: ['electron', 'node-pty', 'occt-import-js', 'meshoptimizer'] }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      lib: { entry: 'electron/preload.ts' },
      rollupOptions: { external: ['electron'] }
    },
    resolve: {
      alias: { '@shared': resolve(__dirname, 'shared') }
    }
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'index.html') }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared')
      }
    },
    plugins: [react()]
  }
})
