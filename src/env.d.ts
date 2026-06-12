/// <reference types="vite/client" />
import type { KadrApi } from '@shared/types'

declare global {
  interface Window {
    kadr: KadrApi
  }
}

export {}
