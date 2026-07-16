import { createSigner } from "@formstr/signer";
import { SimplePool } from "nostr-tools";

// One signer instance for the whole page. appName is what remote signers
// (NIP-46 nostrconnect) display on their approval prompt.
export const signer = createSigner({
  appName: "Mailstr",
  appUrl: "https://mailstr.app",
});

// Shared relay pool for NIP-46 traffic (bunker pairing + silent resume).
export const pool = new SimplePool();

// Relays used for the nostrconnect (Remote QR) pairing flow.
export const NOSTRCONNECT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.nostr.band",
  "wss://nos.lol",
];
