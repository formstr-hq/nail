import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Allows tests to import from nostr-bridge source without a workspace link.
      // e.g. import { parseImetaTags } from "@nostr-bridge/attachment-utils.js"
      "@nostr-bridge": path.resolve(__dirname, "../nostr-bridge/src"),
    },
  },
  test: {
    // E2E tests need generous timeouts (SMTP + relay delivery can take ~30s).
    testTimeout: 90_000,
    hookTimeout: 20_000,
    // Run inbound and outbound suites sequentially — they share ports when no
    // external RELAY_URL is set, so parallel runs would collide.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    include: ["src/**/*.test.ts"],
  },
});
