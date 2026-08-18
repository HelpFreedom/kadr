import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: 'electron/main.ts' },
      // node-pty is a native module — must stay a runtime require
      rollupOptions: { external: ['electron', 'node-pty'] }
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
    // Bind the dev server to the IPv4 loopback explicitly. On Windows with
    // Node >= 17 'localhost' resolves to [::1] first, so Vite can listen on
    // IPv6 only — then Electron's renderer (which connects via 127.0.0.1)
    // gets ERR_CONNECTION_REFUSED and the window stays blank.
    server: {
      host: '127.0.0.1'
    },
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
