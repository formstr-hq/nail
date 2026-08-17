import express from "express";
import { timingSafeEqual } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { nip19 } from "nostr-tools";
import { publishMail } from "./nostr-publisher.js";
import { bytesToMessageString } from "./protocol/bytes.js";
import { lookupNip05 } from "./nip05.js";
import { isNpub, isHexPubkey, splitAddress } from "./protocol/address.js";
import type { ProtocolSigner } from "./protocol/types.js";
import type { UserResolver } from "./user-resolver.js";

/**
 * A content-agnostic mail-send service. It turns an HTTP request into a
 * bridge-originated NIP-59 gift wrap addressed to a Nostr recipient — the same
 * thing `sendBounce` does for delivery failures, but callable by trusted
 * backend services (welcome mail, receipts, ...) instead of only the listener.
 *
 * The bridge holds the signing key and the relay pool, so origination lives
 * here; callers own the *content*. That keeps this a pure transport: adding a
 * new kind of mail is a change in the calling service, never here.
 */

export interface SendDeps {
  signer: ProtocolSigner;
  // Only the relay lookup is needed; typed narrowly so tests can stub it.
  userResolver: Pick<UserResolver, "getDmRelays">;
  localDomains: string[];
  nip05BaseUrl?: string;
}

export interface SendRequest {
  /** npub, 64-char hex pubkey, or a `localpart@domain` address. */
  to: string;
  /** From header; may include a display name. Defaults to postmaster@<domain>. */
  from?: string;
  subject: string;
  text?: string;
  html?: string;
}

export type SendResult =
  | { ok: true; pubkey: string; relays: number }
  | { ok: false; status: number; reason: string };

type RecipientResult =
  | { ok: true; pubkey: string; address?: string }
  | { ok: false; status: number; reason: string };

/**
 * Resolve `to` to a recipient pubkey. An npub or hex key is used directly; an
 * email address is resolved through NIP-05, keeping the not-found (404) and
 * transient-error (502) cases distinct exactly as the LMTP path does.
 */
export async function resolveRecipient(
  to: string,
  nip05BaseUrl?: string,
): Promise<RecipientResult> {
  if (isNpub(to)) {
    try {
      const decoded = nip19.decode(to);
      if (decoded.type === "npub") return { ok: true, pubkey: decoded.data };
    } catch {
      /* fall through to the error below */
    }
    return { ok: false, status: 400, reason: `invalid npub: ${to}` };
  }

  if (isHexPubkey(to)) return { ok: true, pubkey: to };

  const parts = splitAddress(to);
  if (!parts) return { ok: false, status: 400, reason: `invalid recipient: ${to}` };

  const lookup = await lookupNip05(to, nip05BaseUrl);
  if (lookup.status === "error") {
    return { ok: false, status: 502, reason: `NIP-05 lookup failed: ${lookup.message}` };
  }
  if (lookup.status === "not-found") {
    return { ok: false, status: 404, reason: `no NIP-05 record for ${to}` };
  }
  return { ok: true, pubkey: lookup.pubkey, address: `${parts.localpart}@${parts.domain}` };
}

/** The bare address inside a possibly display-named From (`Name <a@b>` → `a@b`). */
function extractAddress(from: string): string {
  const angle = /<([^>]+)>/.exec(from);
  return (angle?.[1] ?? from).trim();
}

/**
 * A From must be on a domain this bridge serves — the same trust rule outbound
 * relaying enforces (§5). A recipient can otherwise be handed mail claiming to
 * come from any domain the bridge speaks for. The display name is preserved for
 * the header; only the address part is validated.
 */
function resolveFrom(
  from: string | undefined,
  localDomains: string[],
): { ok: true; header: string } | { ok: false; reason: string } {
  const header = from?.trim() || `postmaster@${localDomains[0]}`;
  const parts = splitAddress(extractAddress(header));
  if (!parts) return { ok: false, reason: `malformed From address: ${header}` };
  if (!localDomains.includes(parts.domain)) {
    return { ok: false, reason: `From domain "${parts.domain}" is not served by this bridge` };
  }
  return { ok: true, header };
}

/** Build an RFC 2822 message (MIME, Message-ID, Date) from the parts. */
export function composeRawMessage(msg: {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(msg).compile().build((err, message) =>
      err ? reject(err) : resolve(message),
    );
  });
}

/**
 * The core reused by the HTTP handler (and available to the listener): compose,
 * resolve the recipient's relays, and publish a gift wrap. Never throws for the
 * expected failure modes — it returns a `{ ok: false, status }` the HTTP layer
 * maps directly onto a response.
 */
export async function sendSystemMail(
  deps: SendDeps,
  req: SendRequest,
): Promise<SendResult> {
  if (!req.to) return { ok: false, status: 400, reason: "missing 'to'" };
  if (!req.subject) return { ok: false, status: 400, reason: "missing 'subject'" };
  if (!req.text && !req.html) {
    return { ok: false, status: 400, reason: "missing 'text' or 'html'" };
  }

  const recipient = await resolveRecipient(req.to, deps.nip05BaseUrl);
  if (!recipient.ok) return recipient;

  const from = resolveFrom(req.from, deps.localDomains);
  if (!from.ok) return { ok: false, status: 400, reason: from.reason };

  // The visible To: header — the resolved address when we have one, otherwise
  // the bare key, mirroring how sendBounce addresses a keyed-only recipient.
  const toHeader = recipient.address ?? `<${recipient.pubkey}>`;
  const raw = await composeRawMessage({
    from: from.header,
    to: toHeader,
    subject: req.subject,
    text: req.text,
    html: req.html,
  });

  const relays = await deps.userResolver.getDmRelays(recipient.pubkey);
  const published = await publishMail({
    // Byte-string form (§4), the same conversion the LMTP path applies before
    // handing raw bytes to the wrap — nodemailer's output is a Buffer.
    raw: bytesToMessageString(raw),
    recipientPubkey: recipient.pubkey,
    signer: deps.signer,
    relays,
  });

  if (!published) return { ok: false, status: 502, reason: "no relay accepted the message" };
  return { ok: true, pubkey: recipient.pubkey, relays: relays.length };
}

/** Constant-time bearer-token check; a length mismatch short-circuits safely. */
function authorized(req: express.Request, apiKey: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "");
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(apiKey);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function createSendApp(deps: SendDeps & { apiKey: string }): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/v1/send", async (req, res) => {
    if (!authorized(req, deps.apiKey)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    try {
      const result = await sendSystemMail(deps, (req.body ?? {}) as SendRequest);
      if (!result.ok) return res.status(result.status).json({ error: result.reason });
      console.log(
        `nostr-bridge: sent mail to ${result.pubkey.slice(0, 8)} via ${result.relays} relay(s)`,
      );
      return res.status(202).json({ published: true, relays: result.relays });
    } catch (err) {
      console.error("nostr-bridge: send failed:", (err as Error).message);
      return res.status(500).json({ error: "internal error" });
    }
  });

  return app;
}
