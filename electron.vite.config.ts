import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { existsSync } from 'fs'
import { waylandWindow } from './shared/ozone'

// Electron's GPU process is forked from a zygote that starts BEFORE main.ts
// runs, so the EGL vendor for the discrete GPU (electron/gpu.ts) has to be in
// the environment the app is launched with — and this file runs in exactly
// that process. Under X11 the variable changes nothing on its own (Chromium's
// default GL backend there is GLX); it only matters once gpu.ts asks for
// gl-egl. Under WAYLAND it breaks the window outright — Chromium talks to the
// compositor through EGL and NVIDIA's cannot import the Intel card's buffers
// (kadr#44, shared/ozone.ts) — so it is set for an X11 window only.
const NV_EGL = '/usr/share/glvnd/egl_vendor.d/10_nvidia.json'
if (process.platform === 'linux' && existsSync(NV_EGL) && !process.env.__EGL_VENDOR_LIBRARY_FILENAMES &&
    !waylandWindow(process.env, process.argv)) {
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
