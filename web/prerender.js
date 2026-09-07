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

// Keep in sync with the routes handled in src/App.tsx. Each route can carry
// its own <title>, meta description, and robots directives so prerendered
// pages don't all inherit the landing's <head>.
const routes = [
  {
    path: "/",
    // Landing owns the template's <head> already — no overrides needed.
  },
  {
    path: "/privacy-policy",
    title: "Privacy Policy — Mail by Formstr",
    description:
      "How Mail by Formstr handles your data: pseudonymous Nostr public keys, encrypted mail, no trackers, no analytics, no plaintext archive. Lightning-zap payment receipts are public on Nostr relays.",
    // Legal pages stay indexable but de-prioritized vs. the landing.
    robots: "index, follow, max-image-preview:large, max-snippet:-1",
    ogType: "article",
    // Drop the SoftwareApplication/landing-specific JSON-LD for this route;
    // keep Organization + a Policy/Article node instead.
    jsonLd: [
      {
        "@type": "WebPage",
        "@id": "https://mailstr.app/privacy-policy#webpage",
        "url": "https://mailstr.app/privacy-policy",
        "name": "Privacy Policy — Mail by Formstr",
        "isPartOf": { "@id": "https://mailstr.app/#website" },
        "inLanguage": "en-US",
        "description":
          "How Mail by Formstr handles your data: pseudonymous Nostr public keys, encrypted mail, no trackers, no analytics, no plaintext archive.",
        "breadcrumb": {
          "@type": "BreadcrumbList",
          "itemListElement": [
            {
              "@type": "ListItem",
              "position": 1,
              "name": "Home",
              "item": "https://mailstr.app/",
            },
            {
              "@type": "ListItem",
              "position": 2,
              "name": "Privacy Policy",
              "item": "https://mailstr.app/privacy-policy",
            },
          ],
        },
      },
    ],
  },
];

// Replace a <meta> tag (matched by its name or property attribute) inside
// <head>. If the tag isn't present, insert it right before </head>.
function upsertMeta(html, attr, key, content, extraAttrs = {}) {
  // attr is "name" or "property"; key is the attribute value to match.
  const re = new RegExp(
    `<meta\\s+${attr}="${key}"[^>]*>`,
    "i",
  );
  const tag = `<meta ${attr}="${key}"${
    content != null ? ` content="${content.replace(/"/g, "&quot;")}"` : ""
  }${Object.entries(extraAttrs)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("")} />`;
  if (re.test(html)) return html.replace(re, tag);
  return html.replace(/<\/head>/i, `${tag}\n  </head>`);
}

// Replace the <title> … </title> text.
function setTitle(html, title) {
  if (title == null) return html;
  return html.replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`);
}

// Replace <link rel="canonical" href="…">. The template ships with the
// landing's canonical; every other route needs its own or search engines
// treat the page as a duplicate of the home page.
function setCanonical(html, href) {
  if (href == null) return html;
  return html.replace(
    /<link\s+rel="canonical"[^>]*>/i,
    `<link rel="canonical" href="${href}" />`,
  );
}

// Replace the JSON-LD <script type="application/ld+json"> … </script> block.
function setJsonLd(html, graph) {
  const block = `<script type="application/ld+json">\n      ${JSON.stringify(
    { "@context": "https://schema.org", "@graph": graph },
    null,
    2,
  )}\n    </script>`;
  return html.replace(
    /<script type="application\/ld\+json">[\s\S]*?<\/script>/i,
    block,
  );
}

// Build the JSON-LD @graph for a route. The landing keeps its full graph
// from the template; other routes get the Organization + WebSite baseline
// (so sameAs/publisher stay consistent) plus their own nodes.
const baseGraph = JSON.parse(
  template.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/i,
  )[1],
)["@graph"];
const orgNode = baseGraph.find((n) => n["@type"] === "Organization");
const websiteNode = baseGraph.find((n) => n["@type"] === "WebSite");

for (const route of routes) {
  let html = template;

  if (route.title) html = setTitle(html, route.title);
  if (route.description) {
    html = upsertMeta(html, "name", "description", route.description);
    html = upsertMeta(
      html,
      "property",
      "og:description",
      route.description,
    );
    html = upsertMeta(
      html,
      "name",
      "twitter:description",
      route.description,
    );
  }
  if (route.title) {
    html = upsertMeta(
      html,
      "property",
      "og:title",
      route.title,
    );
    html = upsertMeta(html, "name", "twitter:title", route.title);
  }
  if (route.robots) {
    html = upsertMeta(html, "name", "robots", route.robots);
    html = upsertMeta(html, "name", "googlebot", route.robots);
  }
  if (route.ogType) {
    html = upsertMeta(html, "property", "og:type", route.ogType);
    html = upsertMeta(
      html,
      "property",
      "og:url",
      `https://mailstr.app${route.path}`,
    );
  }
  // Every route that isn't the landing needs its own canonical, or
  // search engines treat it as a duplicate of the home page.
  if (route.path !== "/") {
    html = setCanonical(html, `https://mailstr.app${route.path}/`);
  }

  if (route.jsonLd) {
    // Keep Organization + WebSite for publisher consistency, then append
    // route-specific nodes.
    const graph = [orgNode, websiteNode, ...route.jsonLd];
    html = setJsonLd(html, graph);
  }

  // Inject the route's rendered React tree.
  const appHtml = render(route.path);
  html = html.replace(
    '<div id="root"></div>',
    `<div id="root">${appHtml}</div>`,
  );

  const outFile =
    route.path === "/" ? "dist/index.html" : `dist${route.path}/index.html`;
  fs.mkdirSync(path.dirname(abs(outFile)), { recursive: true });
  fs.writeFileSync(abs(outFile), html);
  console.log("pre-rendered", outFile);
}

// The server bundle is only needed during prerender — don't ship it.
fs.rmSync(abs("dist/server"), { recursive: true, force: true });