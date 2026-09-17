// NIP-98 HTTP auth: a kind-27235 event signed by the user, carrying the
// request URL, method, and (for writes) a SHA-256 of the body. Mirrors the
// header format formstr-backend's validateNostrAuth middleware expects.
//
// Payload hashing uses nostr-tools' pure-JS `nip98.hashPayload` rather than
// `crypto.subtle`, which only exists in a secure context and therefore throws
// on plain-HTTP origins (e.g. an IP/Yggdrasil address used for manual testing).
import { nip98 } from "nostr-tools";

export interface Nip98Signer {
  signEvent(event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<unknown>;
}

export async function buildNip98Header(
  signer: Nip98Signer,
  url: string,
  method: string,
  body?: string | object,
): Promise<string> {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];

  if (body !== undefined) {
    // hashPayload runs JSON.stringify itself; hand it the object. Callers may
    // pass the object or its JSON string (both yield the same digest, which is
    // what the backend recomputes from the parsed request body).
    const payload = typeof body === "string" ? JSON.parse(body) : body;
    tags.push(["payload", nip98.hashPayload(payload)]);
  }

  const signed = await signer.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  });

  return `Nostr ${btoa(JSON.stringify(signed))}`;
}
