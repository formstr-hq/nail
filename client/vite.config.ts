import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const API_UPSTREAM = process.env.VITE_API_PROXY_TARGET ?? "https://api.formstr.app";

export default defineConfig({
  base: process.env.CLIENT_BASE_PATH ?? "/",
  plugins: [react()],
  server: {
    // Vite 6 rejects requests whose Host header isn't on an allowlist. For
    // network testing under a custom hostname (e.g. a Yggdrasil DNS name),
    // set VITE_ALLOWED_HOSTS to a comma-separated list; unset = current
    // behaviour (localhost only). Not hardcoded so the repo stays generic.
    allowedHosts: process.env.VITE_ALLOWED_HOSTS
      ? process.env.VITE_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
      : undefined,
    // The e2e run starts the dev server headless where the file watcher is
    // pure overhead (and exhausts inotify instances in sandboxed CI). Disable
    // it there; normal `pnpm dev` keeps HMR.
    watch: process.env.E2E ? null : undefined,
    proxy: {
      // api.formstr.app allows only a fixed set of origins and answers any
      // other with a 500 instead of a CORS rejection, so the browser cannot
      // call it directly from localhost. Proxying makes it a same-origin
      // request in dev; production builds call the API directly, from an
      // origin that is on the allowlist.
      "/api": {
        target: API_UPSTREAM,
        changeOrigin: true,
        secure: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            // changeOrigin rewrites Host but leaves Origin, and forwarding the
            // browser's localhost Origin is exactly what triggers the upstream
            // 500. Drop it so this looks like an ordinary server-side call.
            proxyReq.removeHeader("origin");
            proxyReq.removeHeader("referer");
          });
        },
      },
    },
  },
  resolve: {
    // The protocol sources live in ../nostr-bridge, which has no node_modules
    // of its own, so bare imports like `nostr-tools/pure` in those files can't
    // resolve from their own directory. Dedupe forces Vite to resolve these
    // from the client root, where they're installed.
    dedupe: ["nostr-tools"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The wire protocol lives in nostr-bridge and is shared verbatim with
      // the bridge and the e2e suite, so client and bridge cannot drift apart.
      // Kept outside client/ deliberately; the Dockerfile copies it in.
      "@protocol": path.resolve(__dirname, "../nostr-bridge/src/protocol"),
    },
  },
});
