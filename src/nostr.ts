import fs from "fs";
import path from "path";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
  nip19,
} from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";
import { Relay } from "nostr-tools/relay";
import { config } from "./config.js";

// ── Key Management ──────────────────────────────────────────────

export function loadOrCreateKey(): Uint8Array {
  const keyPath = path.resolve(process.cwd(), config.keyFile);

  if (fs.existsSync(keyPath)) {
    const hex = fs.readFileSync(keyPath, "utf-8").trim();
    console.log("Loaded existing Nostr private key from", config.keyFile);
    return hexToBytes(hex);
  }

  const sk = generateSecretKey();
  fs.writeFileSync(keyPath, bytesToHex(sk), { mode: 0o600 });
  const npub = nip19.npubEncode(getPublicKey(sk));
  console.log("Generated new Nostr key pair");
  console.log("  Your sender npub:", npub);
  console.log("  Private key saved to", config.keyFile);
  return sk;
}

// ── NIP-17 Gift Wrap DM ─────────────────────────────────────────

function createRumor(
  senderPubkey: string,
  recipientPubkey: string,
  content: string,
) {
  return {
    kind: 14,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["p", recipientPubkey]],
    content,
    pubkey: senderPubkey,
  };
}

function createSeal(
  rumor: ReturnType<typeof createRumor>,
  senderSk: Uint8Array,
  recipientPubkey: string,
) {
  const conversationKey = nip44.v2.utils.getConversationKey(
    senderSk,
    recipientPubkey,
  );
  const encryptedRumor = nip44.v2.encrypt(
    JSON.stringify(rumor),
    conversationKey,
  );

  // Randomize timestamp within +-2 days for metadata protection
  const twoDays = 2 * 24 * 60 * 60;
  const randomOffset = Math.floor(Math.random() * twoDays * 2) - twoDays;

  return finalizeEvent(
    {
      kind: 13,
      created_at: Math.floor(Date.now() / 1000) + randomOffset,
      tags: [],
      content: encryptedRumor,
    },
    senderSk,
  );
}

function createGiftWrap(
  seal: ReturnType<typeof createSeal>,
  recipientPubkey: string,
) {
  // Generate a random one-time-use key for the gift wrap
  const wrapperSk = generateSecretKey();

  const conversationKey = nip44.v2.utils.getConversationKey(
    wrapperSk,
    recipientPubkey,
  );
  const encryptedSeal = nip44.v2.encrypt(JSON.stringify(seal), conversationKey);

  // Randomize timestamp within +-2 days
  const twoDays = 2 * 24 * 60 * 60;
  const randomOffset = Math.floor(Math.random() * twoDays * 2) - twoDays;

  return finalizeEvent(
    {
      kind: 1059,
      created_at: Math.floor(Date.now() / 1000) + randomOffset,
      tags: [["p", recipientPubkey]],
      content: encryptedSeal,
    },
    wrapperSk,
  );
}

export function buildGiftWrapDM(
  senderSk: Uint8Array,
  recipientNpub: string,
  content: string,
) {
  const { data: recipientPubkey } = nip19.decode(recipientNpub);
  if (typeof recipientPubkey !== "string") {
    throw new Error("Invalid recipient npub");
  }

  const senderPubkey = getPublicKey(senderSk);
  const rumor = createRumor(senderPubkey, recipientPubkey, content);
  const seal = createSeal(rumor, senderSk, recipientPubkey);
  const wrap = createGiftWrap(seal, recipientPubkey);

  return wrap;
}

// ── Publish to Relays ───────────────────────────────────────────

export async function publishToRelays(
  event: ReturnType<typeof finalizeEvent>,
): Promise<void> {
  const results: { relay: string; ok: boolean; error?: string }[] = [];

  for (const url of config.nostr.relays) {
    try {
      const relay = await Relay.connect(url);
      await relay.publish(event);
      relay.close();
      results.push({ relay: url, ok: true });
    } catch (err: any) {
      results.push({ relay: url, ok: false, error: err.message });
    }
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log(
    `  Published to ${succeeded}/${config.nostr.relays.length} relays`,
  );
  for (const f of failed) {
    console.log(`  Failed: ${f.relay} — ${f.error}`);
  }

  if (succeeded === 0) {
    throw new Error("Failed to publish to any relay");
  }
}
