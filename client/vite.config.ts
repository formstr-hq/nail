import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const API_UPSTREAM = process.env.VITE_API_PROXY_TARGET ?? "https://api.formstr.app";

export default defineConfig({
  base: process.env.CLIENT_BASE_PATH ?? "/",
  plugins: [react()],
  server: {
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
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // The wire protocol lives in nostr-bridge and is shared verbatim with
      // the bridge and the e2e suite, so client and bridge cannot drift apart.
      // Kept outside client/ deliberately; the Dockerfile copies it in.
      "@protocol": path.resolve(__dirname, "../nostr-bridge/src/protocol"),
    },
  },
});
