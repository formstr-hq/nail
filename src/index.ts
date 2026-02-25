import "websocket-polyfill";
import { config } from "./config";
import { fetchUnseenMails } from "./imap";
import { loadOrCreateKey, buildGiftWrapDM, publishToRelays } from "./nostr";

async function main() {
  console.log("=== Mail-to-Nostr ===\n");

  // Load or generate Nostr key
  const senderSk = loadOrCreateKey();

  // Fetch unseen emails
  console.log(`\nFetching unseen emails from ${config.imap.host}...`);
  const mails = await fetchUnseenMails();

  if (mails.length === 0) {
    console.log("No new emails found.");
    return;
  }

  console.log(`Found ${mails.length} unseen email(s)\n`);

  // Send each email as a gift-wrapped DM
  for (const mail of mails) {
    console.log(`Processing: "${mail.subject}" from ${mail.from}`);

    const giftWrap = buildGiftWrapDM(
      senderSk,
      config.nostr.recipientNpub,
      mail.text,
    );
    await publishToRelays(giftWrap);
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
