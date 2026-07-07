import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";

export interface UploadedAttachment {
  url: string;
  sha256: string;
  decryptionKey: string;
  decryptionNonce: string;
}

/** Mirrors nostr-bridge/src/blossom-client.ts's upload path, standalone for the outbound E2E test. */
export async function uploadEncryptedTestAttachment(
  plaintext: Buffer,
  blossomServerUrl: string,
): Promise<UploadedAttachment> {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  const sha256Hex = createHash("sha256").update(ciphertext).digest("hex");

  const now = Math.floor(Date.now() / 1000);
  const authEvent = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      tags: [
        ["t", "upload"],
        ["x", sha256Hex],
        ["expiration", String(now + 300)],
      ],
      content: "Upload test attachment",
    },
    generateSecretKey(),
  );
  const authHeader = Buffer.from(JSON.stringify(authEvent)).toString("base64");

  const res = await fetch(`${blossomServerUrl}/upload`, {
    method: "PUT",
    headers: { Authorization: `Nostr ${authHeader}`, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!res.ok) throw new Error(`Blossom upload failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as { url?: string; sha256?: string };
  return {
    url: body.url ?? `${blossomServerUrl}/${sha256Hex}`,
    sha256: body.sha256 ?? sha256Hex,
    decryptionKey: key.toString("hex"),
    decryptionNonce: iv.toString("hex"),
  };
}
