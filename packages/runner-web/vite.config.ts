import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['@speedrunledger/source', 'module', 'browser', 'development|production'] },
  build: { outDir: 'dist/client', emptyOutDir: true },
})
