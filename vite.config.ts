import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  clearScreen: false,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [resolve(__dirname)]
    }
  },
  build: {
    outDir: resolve(__dirname, 'out/tauri-renderer'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
            return 'vendor-react'
          }
          if (id.includes('node_modules/lucide-react')) {
            return 'vendor-icons'
          }
          if (id.includes('node_modules')) {
            return 'vendor'
          }
          return undefined
        }
      }
    }
  }
})
