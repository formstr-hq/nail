import { describe, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { keySigner } from "./protocol/key-signer.js";
import { unwrapAndVerify } from "./protocol/mail.js";
import { parseRemoteMessageTag } from "./protocol/remote-message.js";
import { buildRemoteMessage } from "./remote-mail.js";

const share = vi.hoisted(() => ({
  upload: vi.fn(),
}));

vi.mock("./drive-share.js", () => ({ uploadDriveShare: share.upload }));
vi.mock("./config.js", () => ({
  config: {
    blossomServerUrl: "https://env.example",
    remoteMessageThresholdBytes: 1024 * 1024,
  },
}));

const BRIDGE_SK = generateSecretKey();
const RECIPIENT_SK = generateSecretKey();
const RECIPIENT = getPublicKey(RECIPIENT_SK);

function rawMessage(): Buffer {
  return Buffer.from(
    [
      "From: Big Sender <big@example.com>",
      "To: me@mailstr.app",
      "Cc: team@example.com",
      "Subject: A very large message",
      "Date: Tue, 2 Jan 2024 00:00:00 +0000",
      "Message-ID: <big@example.com>",
      "References: <parent@example.com>",
      "Content-Type: multipart/mixed; boundary=old",
      "",
      "--old",
      "Content-Type: text/plain",
      "",
      "The full body must not be in the pointer.",
      "--old--",
      "",
    ].join("\r\n"),
  );
}

describe("buildRemoteMessage", () => {
  it("uploads the full RFC 822 message and points to it without copying the body", async () => {
    const raw = rawMessage();
    share.upload.mockResolvedValue({
      filename: "message.eml",
      mimeType: "message/rfc822",
      size: raw.length,
      shareUrl: "https://drive.formstr.app/#shared=naddr1big&k=" + "a".repeat(64),
      server: "https://blossom.example",
      servers: ["https://blossom.example"],
      encryptionKey: "b".repeat(64),
      blobHash: "c".repeat(64),
      unencryptedFileHash: "d".repeat(64),
      chunkSize: 65536,
      deleteKey: "e".repeat(64),
    });

    const result = await buildRemoteMessage({
      raw,
      recipientPubkey: RECIPIENT,
      relays: ["wss://relay.example"],
      signer: keySigner(BRIDGE_SK),
      createdAt: 1_700_000_000,
      servers: ["https://blossom.example"],
    });

    expect(share.upload).toHaveBeenCalledWith(
      raw,
      { filename: "message.eml", mimeType: "message/rfc822" },
      expect.objectContaining({
        servers: ["https://blossom.example"],
        relays: ["wss://relay.example"],
      }),
    );
    expect(result).not.toBeNull();
    if (!result) return;

    const unwrapped = await unwrapAndVerify(result.wrap, keySigner(RECIPIENT_SK), {
      maxAgeSeconds: Infinity,
    });
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;

    expect(unwrapped.rumor.created_at).toBe(1_700_000_000);
    const meta = parseRemoteMessageTag(unwrapped.rumor.tags);
    expect(meta?.servers).toEqual(["https://blossom.example"]);
    expect(meta?.shareUrl).toContain("https://drive.formstr.app/#shared=");

    // The pointer keeps identity/threading, drops the original body and
    // content headers, and includes the bearer link for old clients.
    expect(unwrapped.rumor.content).toContain("From: Big Sender <big@example.com>");
    expect(unwrapped.rumor.content).toContain("Message-ID: <big@example.com>");
    expect(unwrapped.rumor.content).toContain("References: <parent@example.com>");
    expect(unwrapped.rumor.content).not.toContain("The full body must not be in the pointer.");
    expect(unwrapped.rumor.content).not.toContain("multipart/mixed");
    expect(unwrapped.rumor.content).toContain(meta!.shareUrl);
  });
});
