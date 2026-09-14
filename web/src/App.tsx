import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router";
import "./index.css";
import { config } from "./lib/config";
import PrivacyPolicy from "./pages/PrivacyPolicy";
import Home from "./pages/Home";

// The mail client is code-split from the landing: a visitor reading the
// marketing page (the common case, and the one SEO/cold-start cost matters
// for) never downloads the mailbox bundle, and vice versa. The chunk includes
// its own styles (signer CSS) which Vite links on load.
const MailApp = lazy(() => import("./app/App"));

/**
 * Where the mail client mounts.
 *
 * - Web deploy: the bundle is served from `/` (Vite base), and the mail app
 *   lives at `config.mailsUrl` (/mails), which nginx maps to the SPA shell.
 * - A build with `CLIENT_BASE_PATH` set (the Android bundle): the whole app
 *   is served under that base, so the mail app mounts there.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, "");
const APP_PREFIX = BASE || config.mailsUrl.replace(/\/+$/, "") || "/mails";

/**
 * Route table for the merged app.
 *
 * - `/` and `/privacy-policy` are landing routes, prerendered to static HTML
 *   (see prerender.js) and rendered inside a `.landing` scope: it pins the
 *   palette the landing styles with (primary/emphasis) to fixed light-only
 *   values, so the mail app's global `.dark` class (a dark-theme owner's
 *   <html>) can't repaint the hero. See the .landing block in index.css.
 * - The mail client mounts at APP_PREFIX. During prerender this branch never
 *   renders — /mails gets an empty SPA shell, not mail markup, so crawlers
 *   never see the mailbox.
 */
export default function App() {
  return (
    <Routes>
      <Route
        path="/privacy-policy"
        element={
          <div className="landing">
            <PrivacyPolicy />
          </div>
        }
      />
      <Route
        path={`${APP_PREFIX}/*`}
        element={
          <Suspense fallback={null}>
            <MailApp />
          </Suspense>
        }
      />
      <Route
        path="/*"
        element={
          <div className="landing">
            <Home />
          </div>
        }
      />
    </Routes>
  );
}