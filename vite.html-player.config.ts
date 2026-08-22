import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    outDir: 'out/html-player',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/features/htmlPlayer/player.ts'),
      name: 'KadrHtmlPlayer',
      formats: ['iife'],
      fileName: () => 'player.js'
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'shared')
    }
  }
})
