import { defineConfig, type PreviewServer, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import type { Connect } from 'vite'

// Serve prerendered route files (dist/<route>/index.html) before the SPA
// fallback. Without this, `vite preview` serves dist/index.html for every
// non-asset path, so /privacy-policy renders the landing page's prerendered
// tree instead of its own. Returning the handler from
// configurePreviewServer registers it to run BEFORE vite's static middleware,
// which is what we want: matched nested files are served and we end the
// request; unmatched paths fall through to vite's SPA fallback.
function prerouter(): Plugin {
  return {
    name: 'prerouter',
    configurePreviewServer(server: PreviewServer) {
      const handler: Connect.NextHandleFunction = (req, res, next) => {
        const url = req.url ?? '/'
        const pathname = url.split('?')[0].split('#')[0]
        if (pathname === '/' || path.extname(pathname)) return next()

        const candidate = path.join(
          server.config.root,
          server.config.build.outDir,
          pathname,
          'index.html',
        )
        try {
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            const body = fs.readFileSync(candidate)
            res.setHeader('Content-Type', 'text/html')
            res.statusCode = 200
            res.end(body)
            return
          }
        } catch {
          /* fall through to SPA fallback */
        }
        next()
      }
      server.middlewares.use(handler)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), prerouter()],
  // The e2e run starts the dev server headless; disable the file watcher there
  // (pure overhead, and it exhausts inotify instances in sandboxed CI). Normal
  // `pnpm dev` keeps HMR.
  server: { watch: process.env.E2E ? null : undefined },
})