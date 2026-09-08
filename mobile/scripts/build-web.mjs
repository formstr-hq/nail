// Assembles the combined web bundle Capacitor ships in the APK.
//
// The merged app is one build: the landing (prerendered) at '/' and the mail
// app at '/mails/'. The handoff is a plain navigation — landing's
// <a href={config.mailsUrl}> and the post-login redirect both point at /mails.
// We reproduce that layout offline:
//
//   www/index.html       <- prerendered landing (marketing + buy/signup)
//   www/mails/index.html <- the mail app's SPA shell
//
// so inside the WebView '/' is the landing page a signed-out user sees, and
// navigating to /mails drops them into the client exactly like the web.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "../..");
const webDir = path.join(repo, "web");
const www = path.resolve(__dirname, "../www");

// Point the handoff at the client's index file explicitly. Capacitor's local
// server does NOT resolve a bare directory ("/mails/") to its index.html — it
// falls back to the root index.html (the landing SPA), which silently bounces
// you back to landing. Naming the file makes it serve the mail app. This
// overrides the web deploy's "/mails" default for the mobile build only, so
// the deployed site's URLs are unaffected.
const MAILS_URL = "/mails/index.html";
// The whole app builds under the same base its files live at in the bundle.
// (The prerendered landing keeps working under a base: its routes are
// relative to it and index.html references base-prefixed assets.)
const CLIENT_BASE = "/mails/";

function run(cmd, args, cwd, extraEnv = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}  (${path.relative(repo, cwd)})`);
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

// One build serves both halves: the Vite base puts the mail app's assets
// under /mails/, and prerender.js writes the landing at the root plus the
// noindex SPA shell at dist/mails/index.html.
run("pnpm", ["run", "build"], webDir, {
  CLIENT_BASE_PATH: CLIENT_BASE,
  VITE_MAILS_URL: MAILS_URL,
});

// Assemble www/: prerendered pages at the root, and everything the
// `/mails/...` URLs resolve to — the SPA shell plus a copy of the assets —
// under /mails. (One build, base /mails/, means every HTML file references
// assets as /mails/assets/…; Capacitor resolves that to www/mails/assets/.)
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
fs.cpSync(path.join(webDir, "dist"), www, { recursive: true });
fs.cpSync(path.join(www, "assets"), path.join(www, "mails", "assets"), {
  recursive: true,
});
for (const rel of ["favicon.svg", "og-image.png"]) {
  fs.cpSync(path.join(www, rel), path.join(www, "mails", rel));
}

// Guard the invariant the whole handoff depends on: the two entry documents
// must exist where the navigations expect them.
for (const rel of ["index.html", "mails/index.html"]) {
  if (!fs.existsSync(path.join(www, rel))) {
    throw new Error(`combined bundle missing ${rel} — build layout changed?`);
  }
}
console.log(`\n✓ combined bundle assembled at ${path.relative(repo, www)}`);