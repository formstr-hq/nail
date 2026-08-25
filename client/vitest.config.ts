import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@protocol": path.resolve(__dirname, "../nostr-bridge/src/protocol"),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Logic tests run in Node (the default); component tests opt into jsdom with
    // a `// @vitest-environment jsdom` docblock at the top of the file.
    environment: "node",
  },
});
