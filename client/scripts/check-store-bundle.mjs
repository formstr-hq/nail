#!/usr/bin/env node
// check-store-bundle.mjs
//
// Hard rule: nothing Lightning- or card-related may ship in a store build
// (Play AAB, iOS IPA): no code, no copy, no endpoints, no native config. The
// bundler removes the code (lib/payments/methods.ts picks methods on a
// build-time constant); this is the backstop that FAILS THE BUILD if anything
// slipped through, scanning every file in the output, including chunks nothing
// references, plus the native manifests.
//
//   node scripts/check-store-bundle.mjs --mode store [--dir www]
//   node scripts/check-store-bundle.mjs --mode open  [--dir www]   (the open
//     build must still contain Lightning and card: catches an accidental
//     global removal)
//
// The build script writes `<dir>/.build-channel` ("store" | "open"); the check
// refuses to run in a mode that doesn't match, so a Lightning bundle can't be
// packaged as a store build by mistake.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Words and endpoints a store build must not contain (case-insensitive). */
export const DENYLIST = [
  "lightning",
  "bolt11",
  "lnbc",
  "webln",
  "zap",
  "sats",
  "stripe",
  "js.stripe.com",
  "/api/generate-invoice",
  "/api/workspace/generate-invoice",
  "/api/stripe",
  "/api/payments/config",
  "/ws?hash",
  "lightning:",
];

/** What an open build must still contain. */
export const OPEN_REQUIRED = ["/api/generate-invoice/mail", "/api/stripe/checkout", "Pay with Bitcoin"];
/** What a store build must contain: the store method really is in there. */
export const STORE_REQUIRED = ["Restore purchases", "/api/store/verify"];

const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json", ".map", ".md", ".txt", ".svg", ".xml", ".plist", ".webmanifest"]);

/**
 * Library internals that mention a rail but cannot be reached from the app.
 * Each entry masks matching text before scanning, and needs a written reason,
 * reviewed like code. Everything here is dead helper code inside nostr-tools
 * (NIP-57 zap helpers and its kind-name table), pulled in because the library
 * is bundled as a whole; the app never calls any of it.
 */
export const ALLOWLIST = [
  {
    why: "nostr-tools kind-name table (kinds.ts): Zap, ZapGoal, ZapRequest, NutZap, LightningPubRPC are just event-kind labels",
    pattern: /\b(Nut)?Zap(Info|Goal|Request|Receipt)?\b|\bLightningPubRPC\b/g,
  },
  {
    why: "nostr-signer-capacitor-plugin (NIP-55 signer bridge) exposes decryptZapEvent as one of its generic signer calls; the app never invokes it",
    pattern: /\bdecryptZapEvent\b/g,
  },
  {
    why: "nostr-tools nip57 helper names (unused; the app has no zap code)",
    pattern: /\b(getSatoshisAmountFromBolt11|getZapEndpoint|makeZapRequest|makeZapReceipt|validateZapRequest|useFetchImplementation)\b/g,
  },
  {
    why: "nostr-tools nip57 validation messages",
    pattern: /(Invalid zap request JSON|Invalid signature on zap request|Zap request [^"'`]*|zap request[^"'`]*)/gi,
  },
  {
    why: "nostr-tools nip57 reads an invoice's amount prefix (startsWith(\"lnbc\")) and sets the receipt's bolt11 tag",
    pattern: /startsWith\(["']lnbc["']\)|\[["']bolt11["'],/g,
  },
  {
    why: "nostr-tools nip57 receipt builder parameters",
    pattern: /\b(zapRequest|bolt11)\b\s*[:,}]/g,
  },
];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function mask(text) {
  let out = text;
  for (const { pattern } of ALLOWLIST) out = out.replace(pattern, " ");
  return out;
}

/** Denylisted terms found in `text` (after masking allowlisted library text), with context. */
export function findHits(text, file) {
  const masked = mask(text);
  const lower = masked.toLowerCase();
  const hits = [];
  for (const term of DENYLIST) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(term.toLowerCase(), from);
      if (at === -1) break;
      hits.push({
        file,
        term,
        context: masked.slice(Math.max(0, at - 40), at + term.length + 40).replace(/\s+/g, " "),
      });
      from = at + term.length;
      if (hits.length > 200) return hits;
    }
  }
  return hits;
}

export function scanDirectory(dir) {
  const hits = [];
  const present = new Set();
  let corpus = "";
  for (const file of walk(dir)) {
    if (!TEXT_EXT.has(path.extname(file).toLowerCase())) continue;
    const text = fs.readFileSync(file, "utf8");
    corpus += text;
    hits.push(...findHits(text, path.relative(dir, file)));
  }
  return { hits, corpus, present };
}

function nativeFiles() {
  const root = path.resolve(here, "..");
  const candidates = [
    "android/app/src/main/AndroidManifest.xml",
    "android/app/src/play/AndroidManifest.xml",
    "ios/App/App/Info.plist",
  ];
  return candidates.map((rel) => path.join(root, rel)).filter((f) => fs.existsSync(f));
}

/**
 * The native project must match the bundle: the purchase plugin (and with it
 * Play Billing) is present in a store sync and absent from any other, so the
 * direct APK stays free of Google code. `cap sync` decides this (see
 * capacitor.config.ts); a stale sync is the mistake being caught.
 */
export function nativeProblems(mode, root = path.resolve(here, "..")) {
  const gradle = path.join(root, "android/capacitor-cordova-android-plugins/build.gradle");
  if (!fs.existsSync(gradle)) return [];
  const hasBilling = fs.readFileSync(gradle, "utf8").includes("com.android.billingclient");
  if (mode === "open" && hasBilling) {
    return ["android/capacitor-cordova-android-plugins still depends on Play Billing: run `pnpm run sync` (without STORE_BUILD) before building the direct APK"];
  }
  if (mode === "store" && !hasBilling) {
    return ["the Android project has no purchase plugin: run `pnpm run sync:store` before building the Play bundle"];
  }
  return [];
}

export function check({ dir, mode }) {
  const problems = [];
  const channelFile = path.join(dir, ".build-channel");
  const channel = fs.existsSync(channelFile) ? fs.readFileSync(channelFile, "utf8").trim() : "(missing)";
  if (channel !== mode) {
    problems.push(`the bundle in ${dir} was built as '${channel}', expected '${mode}'`);
    return problems;
  }

  const { hits, corpus } = scanDirectory(dir);
  problems.push(...nativeProblems(mode));
  if (mode === "store") {
    for (const hit of hits) problems.push(`${hit.file}: '${hit.term}' …${hit.context}…`);
    for (const file of nativeFiles()) {
      for (const hit of findHits(fs.readFileSync(file, "utf8"), path.relative(path.resolve(here, ".."), file))) {
        problems.push(`${hit.file}: '${hit.term}' …${hit.context}…`);
      }
    }
    for (const needle of STORE_REQUIRED) {
      if (!corpus.includes(needle)) problems.push(`store bundle is missing '${needle}': is this really a store build?`);
    }
  } else {
    for (const needle of OPEN_REQUIRED) {
      if (!corpus.includes(needle)) problems.push(`open bundle is missing '${needle}': was a payment method removed globally?`);
    }
  }
  return problems;
}

function main() {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => {
    const i = args.indexOf(name);
    return i === -1 ? fallback : args[i + 1];
  };
  const mode = arg("--mode", "store");
  const dir = path.resolve(arg("--dir", path.join(here, "../www")));
  if (!["store", "open"].includes(mode)) {
    console.error("--mode must be 'store' or 'open'");
    process.exit(2);
  }
  if (!fs.existsSync(dir)) {
    console.error(`no such directory: ${dir}`);
    process.exit(2);
  }
  const problems = check({ dir, mode });
  if (problems.length > 0) {
    console.error(`\n✗ ${mode} bundle check failed (${problems.length}):`);
    for (const p of problems.slice(0, 40)) console.error(`  - ${p}`);
    if (problems.length > 40) console.error(`  … and ${problems.length - 40} more`);
    process.exit(1);
  }
  console.log(`✓ ${mode} bundle check passed (${path.relative(process.cwd(), dir) || dir})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
