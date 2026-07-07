// Build-time prerendering (SSG).
// Runs after `vite build` (client) and `vite build --ssr` (server bundle):
// renders each route to static HTML and injects it into the built template,
// so crawlers and link scrapers get fully-rendered pages.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const abs = (p) => path.resolve(__dirname, p);

const template = fs.readFileSync(abs("dist/index.html"), "utf-8");
const { render } = await import("./dist/server/entry-server.js");

// Keep in sync with the routes handled in src/App.tsx.
const routes = ["/", "/privacy-policy"];

for (const route of routes) {
  const appHtml = render(route);
  const html = template.replace(
    '<div id="root"></div>',
    `<div id="root">${appHtml}</div>`,
  );
  const outFile =
    route === "/" ? "dist/index.html" : `dist${route}/index.html`;
  fs.mkdirSync(path.dirname(abs(outFile)), { recursive: true });
  fs.writeFileSync(abs(outFile), html);
  console.log("pre-rendered", outFile);
}

// The server bundle is only needed during prerender — don't ship it.
fs.rmSync(abs("dist/server"), { recursive: true, force: true });
