import { createDecipheriv } from "node:crypto";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import nodemailer from "nodemailer";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { unwrapAndVerify, keySigner, messageStringToBytes } from "@nostr-bridge/protocol/index.js";
import { createMockRelay } from "nostr-mock-relay";
import { registerNip05, startNip05Server, stopNip05Server } from "./mocks.js";
import { waitForGiftWrap } from "./nostr-helper.js";
import { env } from "./env.js";

let relayUrl: string;
let stopRelay: () => Promise<void>;

beforeAll(async () => {
  if (env.relayUrl) {
    relayUrl = env.relayUrl;
    stopRelay = async () => {};
  } else {
    const relay = createMockRelay({ host: "0.0.0.0", port: 4600 });
    await relay.start();
    relayUrl = relay.url!;
    stopRelay = () => relay.stop();
  }

  await startNip05Server(env.nip05Port);
}, 15_000);

afterAll(async () => {
  await stopNip05Server();
  await stopRelay();
});

function makeTransport() {
  return nodemailer.createTransport({
    host: env.smtpHost,
    port: env.smtpSubmissionPort,
    secure: false,
    requireTLS: true,
    tls: { rejectUnauthorized: false },
    auth: { user: env.mailcowUser, pass: env.mailcowPassword },
  });
}

describe("inbound email → Nostr DM", () => {
  it(
    "delivers a plain email as a gift-wrapped DM",
    async () => {
      const privkey = generateSecretKey();
      const pubkey = getPublicKey(privkey);
      const marker = randomUUID();
      const localPart = `test-${marker}`;
      registerNip05(localPart, pubkey);

      await makeTransport().sendMail({
        from: env.mailcowUser,
        to: `${localPart}@${env.bridgeDomain}`,
        subject: `Nostr bridge inbound plain test ${marker}`,
        text: `Test body ${marker}`,
      });

      const wrap = await waitForGiftWrap(relayUrl, pubkey, env.deliveryTimeoutMs);
      const result = await unwrapAndVerify(wrap, keySigner(privkey), {
        maxAgeSeconds: Infinity,
      });
      if (!result.ok) throw new Error(`unwrap failed: ${result.reason}`);
      const rumor = result.rumor;
      expect(rumor.content).toContain(marker);
    },
    env.deliveryTimeoutMs + 10_000,
  );

  it(
    "delivers an email with an attachment as a gift-wrapped DM",
    async () => {
      const privkey = generateSecretKey();
      const pubkey = getPublicKey(privkey);
      const marker = randomUUID();
      const localPart = `test-${marker}`;
      registerNip05(localPart, pubkey);

      const attachmentContent = Buffer.from(`attachment payload ${marker}`);
      await makeTransport().sendMail({
        from: env.mailcowUser,
        to: `${localPart}@${env.bridgeDomain}`,
        subject: `Nostr bridge inbound attachment test ${marker}`,
        text: `Test body ${marker}`,
        attachments: [
          {
            filename: "note.txt",
            content: attachmentContent,
            contentType: "text/plain",
          },
        ],
      });

      const wrap = await waitForGiftWrap(relayUrl, pubkey, env.deliveryTimeoutMs);
      const result = await unwrapAndVerify(wrap, keySigner(privkey), {
        maxAgeSeconds: Infinity,
      });
      if (!result.ok) throw new Error(`unwrap failed: ${result.reason}`);
      const rumor = result.rumor;
      console.log(marker, JSON.stringify(rumor));
      expect(rumor.content).toContain(marker);

      const imeta = rumor.tags.find((t) => t[0] === "imeta");
      if (imeta) {
        const field = (name: string) =>
          imeta.find((p) => p.startsWith(`${name} `))?.slice(name.length + 1);
        const url = field("url");
        const decryptionKey = field("decryption-key");
        const decryptionNonce = field("decryption-nonce");

        if (url && decryptionKey && decryptionNonce) {
          const res = await fetch(url);
          expect(res.ok).toBe(true);
          const ciphertext = Buffer.from(await res.arrayBuffer());
          const authTag = ciphertext.subarray(ciphertext.length - 16);
          const body = ciphertext.subarray(0, ciphertext.length - 16);
          const decipher = createDecipheriv(
            "aes-256-gcm",
            Buffer.from(decryptionKey, "hex"),
            Buffer.from(decryptionNonce, "hex"),
          );
          decipher.setAuthTag(authTag);
          const decrypted = Buffer.concat([
            decipher.update(body),
            decipher.final(),
          ]);
          expect(decrypted.equals(attachmentContent)).toBe(true);
        }
      }
    },
    env.deliveryTimeoutMs + 10_000,
  );
});
