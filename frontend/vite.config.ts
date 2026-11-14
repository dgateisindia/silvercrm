import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Development-only same-origin proxy; Express remains bound to loopback.
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api/v1/crm': {
        target: 'http://127.0.0.1:4001',
        changeOrigin: true,
      },
    },
  },
})
