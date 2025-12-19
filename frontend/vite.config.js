import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true, // Allow external connections
    allowedHosts: [
      '.ngrok-free.dev',
      '.ngrok.io',
      '.ngrok.app'
    ],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/auth/accepted': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/auth\/accepted/, '/api/auth/accepted')
      }
    }
  },
  // Ensure SPA routing works for privacy policy and auth pages
  build: {
    rollupOptions: {
      input: {
        main: './index.html'
      }
    }
  }
})


