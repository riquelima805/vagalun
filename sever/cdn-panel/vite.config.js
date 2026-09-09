import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      // aponte para o server.js do node de live/CDN (media.js / points.js)
      '/api': 'http://localhost:4001'
    }
  }
})
