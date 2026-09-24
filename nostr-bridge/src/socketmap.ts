import net from "node:net";

/**
 * Postfix `socketmap:` responder for tenant-domain routing.
 *
 * Postfix's `relay_domains`, `relay_recipient_maps` and `transport_maps` are
 * overridden (via mailcow's `extra.cf`) to consult this endpoint in addition
 * to mailcow's own maps. That makes tenant activation a backend DB write
 * instead of a mailcow control-plane call: Postfix asks us, live, on every
 * message, and we answer from the managed-domain directory.
 *
 * Protocol: netstring-framed single request/reply per connection. Requests are
 * `<mapname> <key>`; replies are `OK <data>`, `NOTFOUND`, `TEMP <reason>`,
 * `PERM <reason>` or `TIMEOUT`. See socketmap_table(5).
 *
 * Failure policy: if the directory is unreachable or its data is stale beyond
 * the hard limit, answer TEMP — Postfix then defers the message and retries.
 * NEVER answer NOTFOUND for a domain we might actually serve: that would
 * permanently bounce real mail. This is the inverse of the usual cache
 * preference, deliberately.
 */

/** netstring: `<byte-length>:<payload>,` */
export function encodeNetstring(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  return Buffer.concat([Buffer.from(`${body.length}:`), body, Buffer.from(",")]);
}

/** Parse one netstring from a buffer. Returns null if incomplete. */
export function decodeNetstring(
  buffer: Buffer,
): { payload: string; rest: Buffer } | null {
  const colon = buffer.indexOf(0x3a); // ":"
  if (colon === -1) return null;
  const length = Number(buffer.subarray(0, colon).toString("ascii"));
  if (!Number.isInteger(length) || length < 0) return null;
  const start = colon + 1;
  const end = start + length;
  if (buffer.length < end + 1) return null;
  if (buffer[end] !== 0x2c) return null; // ","
  return {
    payload: buffer.subarray(start, end).toString("utf8"),
    rest: buffer.subarray(end + 1),
  };
}

export interface SocketmapRequest {
  mapName: string;
  key: string;
}

/** Split `<mapname> <key>`; the key keeps any spaces after the first one. */
export function parseRequest(payload: string): SocketmapRequest | null {
  const space = payload.indexOf(" ");
  if (space <= 0) return null;
  return { mapName: payload.slice(0, space), key: payload.slice(space + 1) };
}

/**
 * The directory the socketmap answers from: which tenant domains are managed,
 * and (for recipient maps) that any localpart is acceptable for them.
 */
export interface DomainDirectory {
  /** Is this domain managed by us (platform or active workspace)? */
  isManagedDomain(domain: string): Promise<boolean>;
  /** Force a refresh from the backend; rejects on failure. */
  refresh(): Promise<void>;
}

export type SocketmapReply =
  | { kind: "ok"; data: string }
  | { kind: "notfound" }
  | { kind: "temp"; reason: string }
  | { kind: "perm"; reason: string };

/**
 * Map names Postfix will query. Kept in one place so the extra.cf wiring and
 * the responder cannot drift.
 */
export const SOCKETMAP_MAPS = {
  relayDomains: "relay_domains",
  relayRecipients: "relay_recipients",
  transport: "transport",
} as const;

export interface ResponderOptions {
  directory: DomainDirectory;
  /**
   * Value returned for `transport`. The transport the mailcow Postfix should
   * use for tenant domains — LMTP into this bridge, matching the platform
   * domain's route (the bridge is already on the mailcow network).
   */
  transportNexthop: string;
}

/**
 * Answer one request. Pure with respect to the socket, so it is unit-testable
 * without a server.
 */
export async function answer(
  request: SocketmapRequest,
  options: ResponderOptions,
): Promise<SocketmapReply> {
  const { directory } = options;

  // Recipient lookups arrive as full addresses (`user@domain`); domain and
  // transport lookups as bare domains. Normalize once.
  const at = request.key.lastIndexOf("@");
  const domain = (at >= 0 ? request.key.slice(at + 1) : request.key).toLowerCase();

  let managed: boolean;
  try {
    managed = await directory.isManagedDomain(domain);
  } catch (err) {
    // Unknown state must defer, never bounce.
    return { kind: "temp", reason: `directory unavailable: ${(err as Error).message}` };
  }

  switch (request.mapName) {
    case SOCKETMAP_MAPS.relayDomains:
      // Relay-domain acceptance: a managed domain is one this MTA is MX for.
      return managed ? { kind: "ok", data: domain } : { kind: "notfound" };

    case SOCKETMAP_MAPS.relayRecipients:
      // Accept every localpart for a managed domain and let the bridge decide
      // whether the mailbox exists (NIP-05). This is what relay_all_recipients
      // gives mailcow's own relay domains, without a mailbox row per address.
      return managed ? { kind: "ok", data: request.key } : { kind: "notfound" };

    case SOCKETMAP_MAPS.transport:
      // LMTP into this bridge, exactly like the platform domain's pcre route.
      return managed
        ? { kind: "ok", data: `lmtp:inet:${options.transportNexthop}` }
        : { kind: "notfound" };

    default:
      return { kind: "notfound" };
  }
}

function formatReply(reply: SocketmapReply): Buffer {
  switch (reply.kind) {
    case "ok":
      return encodeNetstring(`OK ${reply.data}`);
    case "notfound":
      return encodeNetstring("NOTFOUND ");
    case "temp":
      return encodeNetstring(`TEMP ${reply.reason}`);
    case "perm":
      return encodeNetstring(`PERM ${reply.reason}`);
  }
}

/**
 * Start the socketmap server. Returns the net.Server so callers can close it
 * in tests.
 */
export function createSocketmapServer(options: ResponderOptions): net.Server {
  const server = net.createServer((socket) => {
    let buffer: Buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeNetstring(buffer);
      if (!decoded) return; // wait for the rest
      buffer = decoded.rest;

      const request = parseRequest(decoded.payload);
      if (!request) {
        socket.end(formatReply({ kind: "perm", reason: "malformed request" }));
        return;
      }

      void answer(request, options)
        .then((reply) => socket.end(formatReply(reply)))
        .catch((err: Error) => {
          // A throw here is a bug, not a data condition; still defer rather
          // than bounce, because only the message is at stake.
          console.error("nostr-bridge: socketmap handler threw:", err.message);
          socket.end(formatReply({ kind: "temp", reason: "handler error" }));
        });
    });

    socket.on("error", (err) => {
      console.error("nostr-bridge: socketmap socket error:", err.message);
    });
  });

  return server;
}

