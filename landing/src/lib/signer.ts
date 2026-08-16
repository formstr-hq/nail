import { createSigner } from "@formstr/signer";
import { NostrSignerPlugin } from "nostr-signer-capacitor-plugin";
import { SimplePool } from "nostr-tools";

// One signer instance for the whole page. appName is what remote signers
// (NIP-46 nostrconnect) display on their approval prompt. The Android signer
// plugin powers NIP-55 (Amber) login inside the native app; inert on web.
export const signer = createSigner({
  appName: "Mailstr",
  appUrl: "https://mailstr.app",
  androidSignerPlugin: NostrSignerPlugin,
});

// Shared relay pool for NIP-46 traffic (bunker pairing + silent resume).
export const pool = new SimplePool();

// Relays used for the nostrconnect (Remote QR) pairing flow.
export const NOSTRCONNECT_RELAYS = [
  "wss://relay.primal.net",
  "wss://nos.lol",
];
