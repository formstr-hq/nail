import { SimplePool } from "nostr-tools/pool";
import { nip19 } from "nostr-tools";
import { KIND_DM_RELAYS, KIND_PROFILE } from "./protocol/constants.js";
import type { ProtocolSigner } from "./protocol/types.js";

/**
 * Announce the bridge so clients can find it: a kind-10050 saying which relays
 * to send mail to, and a kind-0 whose nip05 matches the `_smtp` record clients
 * resolve. Without these, delivery works only when the client's and bridge's
 * default relay lists happen to overlap.
 */
export async function publishBridgeIdentity(
  pool: SimplePool,
  relays: string[],
  signer: ProtocolSigner,
  domain: string,
): Promise<void> {
  const pubkey = await signer.getPublicKey();
  const created_at = Math.floor(Date.now() / 1000);

  const dmRelayList = await signer.signEvent({
    kind: KIND_DM_RELAYS,
    pubkey,
    created_at,
    tags: relays.map((relay) => ["relay", relay]),
    content: "",
  });

  const profile = await signer.signEvent({
    kind: KIND_PROFILE,
    pubkey,
    created_at,
    tags: [],
    content: JSON.stringify({
      name: `${domain} mail bridge`,
      about: `SMTP bridge for ${domain}. Send kind 1301 gift wraps here to reach legacy email.`,
      nip05: `_smtp@${domain}`,
    }),
  });

  const results = await Promise.allSettled([
    ...pool.publish(relays, dmRelayList),
    ...pool.publish(relays, profile),
  ]);
  const accepted = results.filter((r) => r.status === "fulfilled").length;

  console.log(`nostr-bridge: npub ${nip19.npubEncode(pubkey)}`);
  console.log(`nostr-bridge: published identity to ${accepted}/${results.length} relay slots`);

  if (accepted === 0) {
    console.error(
      "nostr-bridge: WARNING — no relay accepted the identity events; clients may not find this bridge",
    );
  }
}
