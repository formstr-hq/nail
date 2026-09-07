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
  base: process.env.CLIENT_BASE_PATH ?? '/',
  build: {
    // Vite's default assumes "baseline widely available" (~Safari 16.4), which
    // silently excludes every iPhone capped at iOS 15 (6s/7/SE-1). es2020
    // syntax is universally supported since Safari 14 / iOS 14.
    target: ['es2020', 'chrome87', 'firefox78', 'safari14'],
  },
  worker: {
    // Ship the local-relay worker as a classic script (single IIFE bundle),
    // not an ES module: Safari before 15 rejects `{ type: "module" }` workers
    // outright, which kills the entire mailbox — the relay, cache, and every
    // connection run inside this worker. (Becomes load-bearing in Phase 2 when
    // the mail client is ported in.)
    format: 'iife',
  },
  server: {
    // Vite rejects requests whose Host header isn't on an allowlist. For
    // network testing under a custom hostname, set VITE_ALLOWED_HOSTS to a
    // comma-separated list; unset = localhost only.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(',').map((h) => h.trim()).filter(Boolean)
      : undefined,
    // The e2e run starts the dev server headless; disable the file watcher there
    // (pure overhead, and it exhausts inotify instances in sandboxed CI). Normal
    // `pnpm dev` keeps HMR.
    watch: process.env.E2E ? null : undefined,
    proxy: {
      // api.formstr.app allows only a fixed set of origins and answers any
      // other with a 500 instead of a CORS rejection, so the browser cannot
      // call it directly from localhost. Proxying makes it a same-origin
      // request in dev; production builds call the API directly, from an
      // origin that is on the allowlist.
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'https://api.formstr.app',
        changeOrigin: true,
        secure: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // changeOrigin rewrites Host but leaves Origin, and forwarding the
            // browser's localhost Origin is exactly what triggers the upstream
            // 500. Drop it so this looks like an ordinary server-side call.
            proxyReq.removeHeader('origin')
            proxyReq.removeHeader('referer')
          })
        },
      },
    },
  },
  resolve: {
    // The protocol sources live in ../nostr-bridge, which has no node_modules
    // of its own, so bare imports like `nostr-tools/pure` in those files can't
    // resolve from their own directory. Dedupe forces Vite to resolve these
    // from the web root, where they're installed.
    dedupe: ['nostr-tools'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      // The wire protocol lives in nostr-bridge and is shared verbatim with
      // the bridge and the e2e suite, so client and bridge cannot drift apart.
      // Kept outside web/ deliberately; the Dockerfile copies it in.
      '@protocol': path.resolve(__dirname, '../nostr-bridge/src/protocol'),
    },
  },
})