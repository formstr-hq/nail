// Assembles the combined web bundle Capacitor ships in the APK.
//
// The deployed site is two same-origin apps: `landing` at '/' (marketing +
// the buy/signup wizard) and `client` at '/mails/' (the mail app). The handoff
// is a plain navigation — landing's <a href={config.mailsUrl}> and the
// post-login redirect both point at /mails. We reproduce that layout offline:
//
//   www/                 <- landing build (prerendered SPA), served at '/'
//   www/mails/           <- client build, base '/mails/'
//
// so inside the WebView '/' is the landing page a signed-out user sees, and
// navigating to '/mails/' drops them into the client exactly like the web.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, "../..");
const landingDir = path.join(repo, "landing");
const clientDir = path.join(repo, "client");
const www = path.resolve(__dirname, "../www");

// Point the handoff at the client's index file explicitly. Capacitor's local
// server does NOT resolve a bare directory ("/mails/") to its index.html — it
// falls back to the root index.html (the landing SPA), which silently bounces
// you back to landing. Naming the file makes it serve the client bundle. This
// overrides landing's web default of "/mails" for the mobile build only, so
// the deployed site's URLs are unaffected.
const MAILS_URL = "/mails/index.html";
// Client must build under the same base its files live at in the bundle.
const CLIENT_BASE = "/mails/";

function run(cmd, args, cwd, extraEnv = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}  (${path.relative(repo, cwd)})`);
  execFileSync(cmd, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
}

// 1. Build both apps with their existing pipelines (landing = prerendered SSG,
//    client = Vite SPA), only overriding the env that stitches them together.
run("pnpm", ["run", "build"], landingDir, { VITE_MAILS_URL: MAILS_URL });
run("pnpm", ["run", "build"], clientDir, { CLIENT_BASE_PATH: CLIENT_BASE });

// 2. Assemble www/: landing at the root, client under /mails.
fs.rmSync(www, { recursive: true, force: true });
fs.mkdirSync(www, { recursive: true });
fs.cpSync(path.join(landingDir, "dist"), www, { recursive: true });
fs.cpSync(path.join(clientDir, "dist"), path.join(www, "mails"), {
  recursive: true,
});

// Guard the invariant the whole handoff depends on: the two entry documents
// must exist where the navigations expect them.
for (const rel of ["index.html", "mails/index.html"]) {
  if (!fs.existsSync(path.join(www, rel))) {
    throw new Error(`combined bundle missing ${rel} — build layout changed?`);
  }
}
console.log(`\n✓ combined bundle assembled at ${path.relative(repo, www)}`);
