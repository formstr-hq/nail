import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The e2e run starts the dev server headless; disable the file watcher there
  // (pure overhead, and it exhausts inotify instances in sandboxed CI). Normal
  // `pnpm dev` keeps HMR.
  server: { watch: process.env.E2E ? null : undefined },
})
