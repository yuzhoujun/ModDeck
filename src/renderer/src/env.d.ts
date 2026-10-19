import type { ModDeckApi } from '../../shared/ipc'

declare global {
  interface Window {
    moddeck: ModDeckApi
  }
}

export {}
