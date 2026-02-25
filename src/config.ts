import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function required(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env variable: ${name}`);
    console.error(`Copy .env.example to .env and fill in your values.`);
    process.exit(1);
  }
  return val;
}

export const config = {
  imap: {
    host: required("IMAP_HOST"),
    port: parseInt(process.env.IMAP_PORT || "993", 10),
    user: required("IMAP_USER"),
    password: required("IMAP_PASSWORD"),
    tls: process.env.IMAP_TLS !== "false",
  },
  nostr: {
    recipientNpub: required("RECIPIENT_NPUB"),
    relays: (process.env.NOSTR_RELAYS || "wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band")
      .split(",")
      .map((r) => r.trim()),
  },
  keyFile: process.env.KEY_FILE || ".nostr_key",
};
