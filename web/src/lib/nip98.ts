// NIP-98 HTTP auth: a kind-27235 event signed by the user, carrying the
// request URL, method, and (for writes) a SHA-256 of the body. Mirrors the
// header format formstr-backend's validateNostrAuth middleware expects.
import type { NostrEvent } from "nostr-tools";

export interface Nip98Signer {
  signEvent(event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }): Promise<NostrEvent>;
}

export async function buildNip98Header(
  signer: Nip98Signer,
  url: string,
  method: string,
  body?: string,
): Promise<string> {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];

  if (body !== undefined) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    tags.push(["payload", hex]);
  }

  const signed = await signer.signEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  });

  return `Nostr ${btoa(JSON.stringify(signed))}`;
}
