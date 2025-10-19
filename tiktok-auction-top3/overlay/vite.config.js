import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  plugins: [react()],
  preview: {
    host: true, // permite host externo
    port: 8080, // necesario para Railway (usa $PORT)
    allowedHosts: [
      'keen-optimism-production.up.railway.app', // dominio de Railway (frontend)
      'tiklive-production.up.railway.app'        // opcional si frontend y backend comparten host
    ]
  }
})
