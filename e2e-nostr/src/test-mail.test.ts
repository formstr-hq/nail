import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { env } from "./env.js";

// Generic mailcow delivery test: sends via authenticated SMTP submission
// (587 + STARTTLS) and verifies delivery via IMAP (143 + STARTTLS).
// No Nostr bridge involved — this only checks the Postfix → Dovecot pipeline.

async function findAndDeleteMessage(
  marker: string,
  timeoutMs: number,
): Promise<string | null> {
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
            await client.messageDelete(uids, { uid: true });
            return folder;
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

describe("mailcow SMTP → IMAP delivery", () => {
  it(
    "delivers a self-addressed email end to end",
    async () => {
      const marker = randomUUID();

      const transport = nodemailer.createTransport({
        host: env.smtpHost,
        port: env.smtpSubmissionPort,
        secure: false,
        requireTLS: true,
        tls: { rejectUnauthorized: false },
        auth: { user: env.mailcowUser, pass: env.mailcowPassword },
      });

      await transport.sendMail({
        from: env.mailcowUser,
        to: env.mailcowUser,
        subject: `Mailcow delivery test ${marker}`,
        text:
          `Test email sent at ${new Date().toISOString()}\n` +
          `Marker: ${marker}\n` +
          "If you can read this, the Postfix → Dovecot delivery pipeline works.\n",
      });

      const folder = await findAndDeleteMessage(marker, env.deliveryTimeoutMs);
      expect(folder).not.toBeNull();
    },
    env.deliveryTimeoutMs + 10_000,
  );
});
