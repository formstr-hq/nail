/**
 * One-off Gmail/Google Takeout mbox importer.
 *
 * This is an operator tool, not a runtime import path. It uses the bridge's
 * existing protocol builders and publisher, but sets the inner rumor's
 * created_at to the original message date itself. No shared protocol or client
 * behaviour is changed.
 *
 * Run it with the bridge's normal environment (NOSTR_BRIDGE_NSEC,
 * LOCAL_DOMAINS, relay config):
 *
 *   pnpm exec tsx src/tools/import-gmail.ts \
 *     --mbox ./Takeout/Mail/mail.mbox \
 *     --to npub1... \
 *     --relays auto
 *
 * Dry run is the default. Add --publish to actually write to relays.
 */
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { nip19, type Event } from "nostr-tools";
import { generateSecretKey, getEventHash } from "nostr-tools/pure";
import { useWebSocketImplementation } from "nostr-tools/pool";
import { config } from "../config.js";
import { keySigner } from "../protocol/key-signer.js";
import { bytesToMessageString } from "../protocol/bytes.js";
import { buildMailRumor, sealAndWrap } from "../protocol/mail.js";
import { chunkTags, splitMessage } from "../protocol/chunked-mail.js";
import { offloadAttachments } from "../blossom-offload.js";
import { publishToRelay } from "../nostr-publisher.js";
import { RelayWebSocket } from "../relay-socket.js";
import { UserResolver } from "../user-resolver.js";

const HELP = `
Import a Gmail/Google Takeout mbox into one or more Nostr mailboxes with the
bridge key.

Usage:
  pnpm exec tsx src/tools/import-gmail.ts \\
    --mbox ./Takeout/Mail/All\\ mail.mbox \\
    --to npub1... [--to npub1...] \\
    [--relays auto|wss://...,wss://...] \\
    [--blossom-servers https://blossom.one,https://blossom.two] \\
    [--state ./customer.import.jsonl] \\
    [--limit 20] [--since 2020-01-01] [--until 2024-12-31] \\
    [--max-bytes 67108864] \\
    [--message-delay-ms 200] [--wrap-delay-ms 100] [--blossom-delay-ms 500] \\
    [--publish]

--to may be repeated or comma-separated. With several targets, each gets its
own dedupe state file.

Throttling:
  --message-delay-ms  pause after each target's message (default 200)
  --wrap-delay-ms     pause after each published wrap (default 100)
  --blossom-delay-ms  pause after an attachment offload attempt (default 500)
  Pass 0 to disable a delay.

Dry run is the default. --publish actually signs and publishes.
`;

interface Message {
  raw: Buffer;
  date: number;
  messageId?: string;
  subject?: string;
}

interface StateEntry {
  id: string;
  messageId?: string;
  date: number;
  subject?: string;
  status: "ok" | "failed";
  at: string;
  detail?: string;
}

interface Target {
  pubkey: string;
  label: string;
  relays: string[];
  statePath: string;
  done: Set<string>;
  imported: number;
  chunked: number;
  failed: number;
  wouldImport: number;
}

type MboxItem =
  | { type: "message"; message: Message }
  | { type: "oversized"; index: number; bytes: number };

function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseTarget(input: string): string {
  const value = input.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  try {
    const decoded = nip19.decode(value);
    if (decoded.type === "npub") return decoded.data;
  } catch {
    // fall through
  }
  throw new Error(`--to must be an npub or 64-character hex pubkey: ${value}`);
}

function shortNpub(pubkey: string): string {
  return nip19.npubEncode(pubkey).slice(0, 12);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDate(value: string | undefined, label: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`${label} must be a parseable date`);
  return Math.floor(parsed / 1000);
}

function headerEnd(raw: Buffer): number {
  const crlf = raw.indexOf(Buffer.from("\r\n\r\n"));
  const lf = raw.indexOf(Buffer.from("\n\n"));
  if (crlf === -1 && lf === -1) return raw.length;
  if (crlf === -1) return lf;
  if (lf === -1) return crlf;
  return Math.min(crlf, lf);
}

function parseHeaders(raw: Buffer): Map<string, string> {
  const text = raw.subarray(0, headerEnd(raw)).toString("latin1");
  const headers = new Map<string, string>();
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      headers.set(current, `${headers.get(current) ?? ""} ${line.trim()}`.trim());
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      current = null;
      continue;
    }
    current = line.slice(0, colon).trim().toLowerCase();
    headers.set(current, line.slice(colon + 1).trim());
  }
  return headers;
}

function parseMessage(raw: Buffer): Message {
  let body = raw;
  let envelopeDate: number | undefined;
  if (raw.subarray(0, 5).equals(Buffer.from("From "))) {
    const newline = raw.indexOf(0x0a);
    if (newline !== -1) {
      const envelope = raw.subarray(0, newline).toString("latin1").replace(/\r$/, "");
      const parsed = Date.parse(envelope.replace(/^From\s+\S+\s+/, ""));
      if (!Number.isNaN(parsed)) envelopeDate = Math.floor(parsed / 1000);
      body = raw.subarray(newline + 1);
    }
  }

  // mboxrd escapes body lines matching ^>*From with one extra >.
  const unescaped = Buffer.from(
    body.toString("latin1").replace(/(^|\r?\n)>From /g, "$1From "),
    "latin1",
  );
  const headers = parseHeaders(unescaped);
  const headerDate = headers.get("date");
  const parsedDate = headerDate ? Date.parse(headerDate) : Number.NaN;
  const date = Number.isFinite(parsedDate)
    ? Math.floor(parsedDate / 1000)
    : (envelopeDate ?? Math.floor(Date.now() / 1000));

  return {
    raw: unescaped,
    date,
    messageId: headers.get("message-id"),
    subject: headers.get("subject"),
  };
}

/**
 * Stream an mbox. Messages above maxMessageBytes are reported and skipped
 * without aborting the rest of the archive.
 */
async function* readMbox(
  path: string,
  maxMessageBytes: number,
): AsyncGenerator<MboxItem> {
  const stream = createReadStream(path);
  const boundary = Buffer.from("\nFrom ");
  let buffer = Buffer.alloc(0);
  let index = 0;
  let discarding = false;

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk as Buffer]);

    if (discarding) {
      const marker = buffer.indexOf(boundary);
      if (marker === -1) {
        buffer = Buffer.alloc(0);
        continue;
      }
      buffer = buffer.subarray(marker + 1);
      discarding = false;
    }

    while (true) {
      const marker = buffer.indexOf(boundary);
      if (marker === -1) {
        if (buffer.length > maxMessageBytes) {
          yield { type: "oversized", index: index++, bytes: buffer.length };
          buffer = Buffer.alloc(0);
          discarding = true;
        }
        break;
      }

      if (marker > maxMessageBytes) {
        yield { type: "oversized", index: index++, bytes: marker };
        buffer = buffer.subarray(marker + 1);
        continue;
      }

      const message = buffer.subarray(0, marker);
      buffer = buffer.subarray(marker + 1);
      yield { type: "message", message: parseMessage(message) };
      index += 1;
    }
  }

  if (!discarding && buffer.length > 0) {
    if (buffer.length > maxMessageBytes) {
      yield { type: "oversized", index, bytes: buffer.length };
    } else {
      yield { type: "message", message: parseMessage(buffer) };
    }
  }
}

function messageKey(message: Message): string {
  if (message.messageId?.trim()) return `mid:${message.messageId.trim().toLowerCase()}`;
  return `sha256:${createHash("sha256").update(message.raw).digest("hex")}`;
}

function loadState(path: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(path)) return done;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as StateEntry;
      if (entry.status === "ok" && entry.id) done.add(entry.id);
    } catch {
      console.warn(`warning: ignoring malformed state line in ${path}`);
    }
  }
  return done;
}

function appendState(path: string, entry: StateEntry): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/**
 * Build wraps with the ORIGINAL date on the inner rumor.
 *
 * buildMailRumor currently stamps created_at=now, so this script mutates the
 * unsigned rumor and recomputes its id. That is deliberately local to the tool:
 * it avoids touching the shared protocol for a one-off migration.
 */
async function buildImportedWraps(
  raw: string,
  createdAt: number,
  targetPubkey: string,
  maxChunks: number,
  signer: ReturnType<typeof keySigner>,
): Promise<{ wraps: Event[]; parts: number } | { error: string }> {
  const senderPubkey = await signer.getPublicKey();
  const { msgid, totalBytes, slices } = await splitMessage(raw, {
    senderPubkey,
    recipientPubkey: targetPubkey,
  });
  if (slices.length > maxChunks) {
    return { error: `needs ${slices.length} chunks (max ${maxChunks})` };
  }

  const wraps: Event[] = [];
  for (let i = 0; i < slices.length; i++) {
    const ephemeralSk = generateSecretKey();
    const rumor = buildMailRumor({
      senderPubkey,
      recipientPubkey: targetPubkey,
      rfc2822: slices[i],
      wrapSecret: ephemeralSk,
      extraTags:
        slices.length > 1 ? chunkTags(msgid, i, slices.length, totalBytes) : [],
    });
    rumor.created_at = createdAt;
    rumor.id = getEventHash(rumor);
    wraps.push(await sealAndWrap(rumor, targetPubkey, signer, { ephemeralSk }));
  }
  return { wraps, parts: slices.length };
}

function statePathFor(
  mboxPath: string,
  value: string | undefined,
  pubkey: string,
  multiple: boolean,
): string {
  const fallback = `${mboxPath}.imported.jsonl`;
  if (!multiple) return resolve(value ?? fallback);
  const base = resolve(value ?? `${mboxPath}.imported`);
  return `${base.replace(/\.jsonl$/i, "")}.${shortNpub(pubkey)}.jsonl`;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      mbox: { type: "string" },
      to: { type: "string", multiple: true },
      relays: { type: "string" },
      "blossom-servers": { type: "string", multiple: true },
      state: { type: "string" },
      limit: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      "max-bytes": { type: "string" },
      "message-delay-ms": { type: "string" },
      "wrap-delay-ms": { type: "string" },
      "blossom-delay-ms": { type: "string" },
      publish: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP.trim());
    return;
  }
  if (!values.mbox) die("--mbox is required");

  const requestedTargets = [...new Set(
    (values.to ?? [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean)
      .map(parseTarget),
  )];
  if (requestedTargets.length === 0) die("--to is required");

  const mboxPath = resolve(values.mbox);
  const limit = values.limit ? Number(values.limit) : undefined;
  const maxBytes = values["max-bytes"] ? Number(values["max-bytes"]) : 64 * 1024 * 1024;
  const messageDelayMs = values["message-delay-ms"]
    ? Number(values["message-delay-ms"])
    : 200;
  const wrapDelayMs = values["wrap-delay-ms"] ? Number(values["wrap-delay-ms"]) : 100;
  const blossomDelayMs = values["blossom-delay-ms"]
    ? Number(values["blossom-delay-ms"])
    : 500;
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    die("--limit must be a positive integer");
  }
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    die("--max-bytes must be a positive integer");
  }
  for (const [label, value] of [
    ["--message-delay-ms", messageDelayMs],
    ["--wrap-delay-ms", wrapDelayMs],
    ["--blossom-delay-ms", blossomDelayMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      die(`${label} must be a non-negative integer`);
    }
  }
  const blossomServers = [...new Set(
    (values["blossom-servers"] ?? [])
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  )];
  const since = parseDate(values.since, "--since");
  const until = parseDate(values.until, "--until");
  if (since !== undefined && until !== undefined && since > until) {
    die("--since must be before --until");
  }

  useWebSocketImplementation(RelayWebSocket);
  const signer = keySigner(config.bridgePrivkey);
  const resolver =
    values.relays && values.relays !== "auto"
      ? null
      : new UserResolver(
          config.bootstrapRelays,
          config.bridgeRelays,
          config.relayCacheMax,
          config.relayCacheTtlMs,
        );
  const fixedRelays =
    values.relays && values.relays !== "auto"
      ? values.relays.split(",").map((relay) => relay.trim()).filter(Boolean)
      : null;

  const targets: Target[] = [];
  for (const pubkey of requestedTargets) {
    const relays = fixedRelays ?? (await resolver!.getDmRelays(pubkey));
    if (relays.length === 0) die(`no relay list resolved for ${shortNpub(pubkey)}`);
    const statePath = statePathFor(
      mboxPath,
      values.state,
      pubkey,
      requestedTargets.length > 1,
    );
    targets.push({
      pubkey,
      label: shortNpub(pubkey),
      relays,
      statePath,
      done: loadState(statePath),
      imported: 0,
      chunked: 0,
      failed: 0,
      wouldImport: 0,
    });
  }

  console.log(
    `${values.publish ? "IMPORT" : "DRY RUN"} ${basename(mboxPath)} -> ${targets.length} target(s)`,
  );
  if (blossomServers.length) {
    console.log(`blossom: ${blossomServers.join(", ")} (operator default remains fallback)`);
  }
  for (const target of targets) {
    console.log(`\n${target.label}: ${target.relays.join(", ")}`);
    console.log(`  state: ${target.statePath}`);
  }

  let processed = 0;
  let skipped = 0;
  let oversized = 0;

  for await (const item of readMbox(mboxPath, maxBytes)) {
    if (item.type === "oversized") {
      oversized += 1;
      console.warn(
        `[${item.index}] skip oversized message: ${item.bytes} bytes (limit ${maxBytes})`,
      );
      continue;
    }
    if (limit !== undefined && processed >= limit) break;
    processed += 1;

    const message = item.message;
    if (since !== undefined && message.date < since) {
      skipped += 1;
      continue;
    }
    if (until !== undefined && message.date > until) {
      skipped += 1;
      continue;
    }

    const id = messageKey(message);
    const date = new Date(message.date * 1000).toISOString().slice(0, 10);
    const label = message.subject?.slice(0, 70) || "(no subject)";
    const raw = bytesToMessageString(message.raw);

    const active = targets.filter((target) => !target.done.has(id));
    if (active.length === 0) {
      skipped += 1;
      console.log(`[${processed}] skip duplicate ${message.messageId ?? id.slice(0, 20)}`);
      continue;
    }

    if (!values.publish) {
      for (const target of active) {
        target.done.add(id);
        target.wouldImport += 1;
      }
      console.log(
        `[${processed}] ${date} ${label} (${message.raw.length} bytes) -> would import to ${active.length} target(s)`,
      );
      continue;
    }

    for (const target of active) {
      try {
        let outgoing = raw;
        // Match the bridge's inbound path for attachment-heavy mail: encrypt
        // attachments to the recipient, upload to Blossom, and replace them
        // with drive links. If offload is unavailable, chunking still runs.
        if (message.raw.length > config.maxWrappableMessageBytes) {
          try {
            const offload = await offloadAttachments(message.raw, {
              recipientPubkey: target.pubkey,
              relays: target.relays,
              recipient: target.label,
              userServers: blossomServers.length ? blossomServers : undefined,
            });
            if (offload) outgoing = offload.raw;
            if (blossomDelayMs > 0) await sleep(blossomDelayMs);
          } catch (error) {
            console.warn(
              `  ${target.label}: attachment offload failed: ${(error as Error).message}`,
            );
            if (blossomDelayMs > 0) await sleep(blossomDelayMs);
          }
        }

        const built = await buildImportedWraps(
          outgoing,
          message.date,
          target.pubkey,
          config.maxChunkCount,
          signer,
        );
        if ("error" in built) {
          target.failed += 1;
          appendState(target.statePath, {
            id,
            messageId: message.messageId,
            date: message.date,
            subject: message.subject,
            status: "failed",
            at: new Date().toISOString(),
            detail: built.error,
          });
          console.warn(`  ${target.label}: skipped: ${built.error}`);
          continue;
        }

        let delivered = true;
        for (const wrap of built.wraps) {
          const results = await Promise.all(
            target.relays.map((relay) => publishToRelay(relay, wrap, signer)),
          );
          if (!results.some(Boolean)) {
            delivered = false;
            break;
          }
          if (wrapDelayMs > 0) await sleep(wrapDelayMs);
        }
        if (!delivered) {
          target.failed += 1;
          appendState(target.statePath, {
            id,
            messageId: message.messageId,
            date: message.date,
            subject: message.subject,
            status: "failed",
            at: new Date().toISOString(),
            detail: "no relay accepted a wrap",
          });
          console.warn(`  ${target.label}: failed: no relay accepted`);
          continue;
        }

        target.imported += 1;
        target.chunked += built.parts > 1 ? 1 : 0;
        target.done.add(id);
        appendState(target.statePath, {
          id,
          messageId: message.messageId,
          date: message.date,
          subject: message.subject,
          status: "ok",
          at: new Date().toISOString(),
          detail: built.parts > 1 ? `${built.parts} parts` : undefined,
        });
        console.log(
          `  ${target.label}: imported${built.parts > 1 ? ` (${built.parts} parts)` : ""}`,
        );
      } catch (error) {
        target.failed += 1;
        appendState(target.statePath, {
          id,
          messageId: message.messageId,
          date: message.date,
          subject: message.subject,
          status: "failed",
          at: new Date().toISOString(),
          detail: (error as Error).message,
        });
        console.error(`  ${target.label}: failed: ${(error as Error).message}`);
      } finally {
        if (messageDelayMs > 0) await sleep(messageDelayMs);
      }
    }
    console.log(`[${processed}] ${date} ${label}`);
  }

  console.log(
    `\n${values.publish ? "Import" : "Dry run"} complete: ${processed} scanned, ` +
      `${skipped} duplicate/date-skipped, ${oversized} oversized.`,
  );
  for (const target of targets) {
    console.log(
      `  ${target.label}: ` +
        (values.publish
          ? `${target.imported} imported, ${target.chunked} chunked, ${target.failed} failed`
          : `${target.wouldImport} would import`),
    );
  }
  if (targets.some((target) => target.failed > 0)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
