import WebSocket from "ws";
import { createRumor, createSeal, createWrap } from "nostr-tools/nip59";
import { deriveSecretKey } from "./key-derivation.js";
import { uploadEncryptedAttachment } from "./blossom-client.js";
import type { ParsedEmail } from "./email-parser.js";

function publishToRelay(
  relayUrl: string,
  event: { id: string },
  timeoutMs = 4000,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };

    const ws = new WebSocket(relayUrl);
    const timer = setTimeout(() => finish(false), timeoutMs);

    ws.on("open", () => ws.send(JSON.stringify(["EVENT", event])));
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data[0] === "OK" && data[1] === event.id) finish(Boolean(data[2]));
      } catch {
        // ignore malformed relay messages
      }
    });
    ws.on("error", (error) => {
      console.error("Relay error", error);
      finish(false);
    });
  });
}

export async function publishDM(
  masterSecret: Uint8Array,
  recipientPubkey: string,
  email: ParsedEmail,
  writeRelays: string[],
  blossomServerUrl: string,
): Promise<boolean> {
  const senderSecretKey = deriveSecretKey(masterSecret, recipientPubkey);

  const imetaTags: string[][] = [];
  for (const attachment of email.attachments) {
    const uploaded = await uploadEncryptedAttachment(
      attachment.content,
      senderSecretKey,
      blossomServerUrl,
    );
    imetaTags.push([
      "imeta",
      `url ${uploaded.url}`,
      "m application/octet-stream",
      `x ${uploaded.sha256}`,
      `size ${attachment.content.length}`,
      `filename ${attachment.filename}`,
      `decryption-key ${uploaded.encryptionKey}`,
      `decryption-nonce ${uploaded.decryptionNonce}`,
      "encryption-algorithm aes-256-gcm",
    ]);
  }

  const content = email.subject
    ? `Subject: ${email.subject}\n\n${email.text}`
    : email.text;

  const rumor = createRumor(
    {
      kind: 14,
      content,
      tags: [["p", recipientPubkey], ...imetaTags],
    },
    senderSecretKey,
  );

  const seal = createSeal(rumor, senderSecretKey, recipientPubkey);
  const wrap = createWrap(seal, recipientPubkey);

  const results = await Promise.all(
    writeRelays.map((relay) => publishToRelay(relay, wrap)),
  );
  return results.some(Boolean);
}
