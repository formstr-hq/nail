import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  base: process.env.CLIENT_BASE_PATH ?? "/",
  plugins: [react()],
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
