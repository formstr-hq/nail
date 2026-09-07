import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
// Self-hosted: index.css asks for these by name, and a webfont that never
// loads fails silently — the whole UI just renders in system-ui instead.
import "@fontsource-variable/inter";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./index.css";
// Pre-paint theme: toggles the `dark` class (mail app tokens) + colorScheme.
// The landing is light-only, so for it this is inert.
import { applyStoredTheme } from "./app/store/theme";
import {
  ErrorBoundary,
  installGlobalErrorCapture,
} from "./app/components/DebugErrorOverlay";
import App from "./App";

applyStoredTheme();
installGlobalErrorCapture();

const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);

// Prerendered HTML is present in production → hydrate it.
// In dev the root is empty → mount a fresh tree.
if (root.hasChildNodes()) {
  hydrateRoot(root, app);
} else {
  createRoot(root).render(app);
}