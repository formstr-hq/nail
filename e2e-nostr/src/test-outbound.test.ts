import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import nodemailer from "nodemailer";
import { generateSecretKey } from "nostr-tools/pure";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createMockRelay } from "nostr-mock-relay";
import { buildMailGiftWrap, publishToRelay } from "./nostr-helper.js";
import { uploadEncryptedTestAttachment } from "./blossom-helper.js";
import { env } from "./env.js";

let relayUrl: string;
let stopRelay: () => Promise<void>;

beforeAll(async () => {
  if (env.relayUrl) {
    relayUrl = env.relayUrl;
    stopRelay = async () => {};
  } else {
    const relay = createMockRelay({ host: "0.0.0.0", port: 4601 });
    await relay.start();
    relayUrl = relay.url!;
    stopRelay = () => relay.stop();
  }
}, 15_000);

afterAll(async () => {
  await stopRelay();
});

async function findAndDeleteMessage(
  marker: string,
  timeoutMs: number,
): Promise<{ folder: string; source: Buffer } | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const client = new ImapFlow({
      host: env.imapHost,
      port: env.imapPort,
      secure: false,
      tls: { rejectUnauthorized: false },
      auth: { user: env.mailcowUser, pass: env.mailcowPassword },
      logger: false,
    });

    try {
      await client.connect();
      for (const folder of ["INBOX", "Junk", "Spam"]) {
        const lock = await client.getMailboxLock(folder);
        try {
          const uids = await client.search({ subject: marker }, { uid: true });
          if (uids && uids.length > 0) {
            const chunks: Buffer[] = [];
            for await (const msg of client.fetch(
              uids,
              { source: true },
              { uid: true },
            )) {
              if (msg.source) chunks.push(msg.source);
            }
            await client.messageDelete(uids, { uid: true });
            return { folder, source: chunks[0] };
          }
        } finally {
          lock.release();
        }
      }
    } catch (err) {
      console.error("IMAP check error (retrying):", (err as Error).message);
    } finally {
      await client.logout().catch(() => {});
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  return null;
}

async function buildRfc2822(opts: nodemailer.SendMailOptions): Promise<string> {
  const transport = nodemailer.createTransport({
    streamTransport: true,
    newline: "unix",
  });
  const info = (await transport.sendMail(opts)) as unknown as {
    message: NodeJS.ReadableStream;
  };
  const chunks: Buffer[] = [];
  for await (const chunk of info.message) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function publishMailEvent(rfc2822: string): Promise<void> {
  const senderPrivkey = generateSecretKey();
  const wrap = buildMailGiftWrap(rfc2822, senderPrivkey, env.bridgePubkey);
  const ok = await publishToRelay(relayUrl, wrap);
  expect(ok).toBe(true);
}

describe("outbound Nostr DM → email", () => {
  it(
    "delivers a plain Nostr mail event as an email",
    async () => {
      const marker = randomUUID();
      const rfc2822 = await buildRfc2822({
        from: `sender@${env.bridgeDomain}`,
        to: env.mailcowUser,
        subject: `Nostr bridge outbound plain test ${marker}`,
        text: `Test body ${marker}`,
      });

      await publishMailEvent(rfc2822);

      const delivered = await findAndDeleteMessage(
        marker,
        env.deliveryTimeoutMs,
      );
      expect(delivered).not.toBeNull();
    },
    env.deliveryTimeoutMs + 10_000,
  );

  it(
    "delivers a Nostr mail event with an imeta attachment as an email with that attachment",
    async () => {
      const marker = randomUUID();
      const attachmentContent = Buffer.from(`attachment payload ${marker}`);

      const uploaded = await uploadEncryptedTestAttachment(
        attachmentContent,
        env.blossomServerUrl,
      );

      const imetaTags: string[][] = [
        [
          "imeta",
          `url ${uploaded.url}`,
          "m application/octet-stream",
          `x ${uploaded.sha256}`,
          `size ${attachmentContent.length}`,
          "filename test-attachment.bin",
          `decryption-key ${uploaded.decryptionKey}`,
          `decryption-nonce ${uploaded.decryptionNonce}`,
          "encryption-algorithm aes-256-gcm",
        ],
      ];

      const rfc2822 = await buildRfc2822({
        from: `sender@${env.bridgeDomain}`,
        to: env.mailcowUser,
        subject: `Nostr bridge outbound attachment test ${marker}`,
        text: `Test body ${marker}`,
      });

      const senderPrivkey = generateSecretKey();
      const wrap = buildMailGiftWrap(rfc2822, senderPrivkey, env.bridgePubkey, imetaTags);
      const ok = await publishToRelay(relayUrl, wrap);
      expect(ok).toBe(true);

      const delivered = await findAndDeleteMessage(marker, env.deliveryTimeoutMs);
      expect(delivered).not.toBeNull();

      const parsed = await simpleParser(delivered!.source);
      expect(parsed.attachments).toHaveLength(1);
      const att = parsed.attachments[0];
      expect(att.filename).toBe("test-attachment.bin");
      expect(att.content.equals(attachmentContent)).toBe(true);
    },
    env.deliveryTimeoutMs + 10_000,
  );
});
