import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const fixtureZip = resolve(
  here,
  "../../../e2e-nostr/fixtures/takeout-20261121T111735Z-1-001.zip",
);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function npub(): string {
  return nip19.npubEncode(getPublicKey(generateSecretKey()));
}

function nsec(): string {
  return nip19.nsecEncode(generateSecretKey());
}

function runDryRun(args: string[]): string {
  return execFileSync(
    "pnpm",
    ["exec", "tsx", "src/tools/import-gmail.ts", ...args],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        NOSTR_BRIDGE_NSEC: nsec(),
        LOCAL_DOMAINS: "mailstr.app",
      },
      timeout: 30_000,
    },
  ).toString();
}

describe("import-gmail script", () => {
  it("dry-runs the real Takeout fixture for multiple targets without publishing", () => {
    const dir = mkdtempSync(join(tmpdir(), "import-gmail-test-"));
    dirs.push(dir);
    const mboxPath = join(dir, "github.mbox");

    // The fixture is the small Google Takeout ZIP the user added. Use the
    // system unzip so the test exercises the exact archive shape.
    writeFileSync(
      mboxPath,
      execFileSync("unzip", ["-p", fixtureZip, "Takeout/Mail/github.mbox"], {
        maxBuffer: 16 * 1024 * 1024,
      }),
    );

    const first = npub();
    const second = npub();
    const output = runDryRun([
      "--mbox",
      mboxPath,
      "--to",
      first,
      "--to",
      second,
      "--relays",
      "wss://relay.example",
      "--blossom-servers",
      "https://blossom.example",
    ]);

    expect(output).toContain("DRY RUN");
    expect(output).toContain("2 target(s)");
    expect(output).toContain("blossom: https://blossom.example");
    expect(output).toContain("7 scanned");
    expect(output).toContain("7 would import");
    expect(output.match(/would import to 2 target\(s\)/g)).toHaveLength(7);
    expect(output).toContain(first.slice(0, 12));
    expect(output).toContain(second.slice(0, 12));
    // A dry run must not create per-target checkpoint files.
    expect(existsSync(`${mboxPath}.imported.jsonl`)).toBe(false);
    expect(existsSync(`${mboxPath}.imported.${first.slice(0, 12)}.jsonl`)).toBe(false);
  });

  it("skips an oversized message and continues with the rest of the archive", () => {
    const dir = mkdtempSync(join(tmpdir(), "import-gmail-oversize-"));
    dirs.push(dir);
    const mboxPath = join(dir, "oversize.mbox");
    writeFileSync(
      mboxPath,
      [
        "From alice@example.com Mon Jan  1 00:00:00 +0000 2024",
        "Date: Mon, 1 Jan 2024 00:00:00 +0000",
        "Message-ID: <huge@example.com>",
        "Subject: Huge",
        "",
        "x".repeat(2000),
        "",
        "From bob@example.com Tue Jan  2 00:00:00 +0000 2024",
        "Date: Tue, 2 Jan 2024 00:00:00 +0000",
        "Message-ID: <small@example.com>",
        "Subject: Small",
        "",
        "Hello",
      ].join("\n"),
    );

    const output = runDryRun([
      "--mbox",
      mboxPath,
      "--to",
      npub(),
      "--relays",
      "wss://relay.example",
      "--max-bytes",
      "500",
    ]);

    expect(output).toContain("1 oversized");
    expect(output).toContain("1 scanned");
    expect(output).toContain("1 would import");
  });
});
