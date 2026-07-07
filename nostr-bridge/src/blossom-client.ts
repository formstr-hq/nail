import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { finalizeEvent } from "nostr-tools/pure";

export interface UploadedAttachment {
  url: string;
  sha256: string;
  encryptionKey: string;
  decryptionNonce: string;
}

function encryptAesGcm(plaintext: Buffer): { ciphertext: Buffer; key: Buffer; iv: Buffer } {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext, key, iv };
}

function decryptAesGcm(blob: Buffer, key: Buffer, iv: Buffer): Buffer {
  const authTag = blob.subarray(blob.length - 16);
  const ciphertext = blob.subarray(0, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function buildUploadAuthEvent(sha256Hex: string, derivedSecretKey: Uint8Array) {
  const now = Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      tags: [
        ["t", "upload"],
        ["x", sha256Hex],
        ["expiration", String(now + 300)],
      ],
      content: "Upload attachment",
    },
    derivedSecretKey,
  );
}

export async function uploadEncryptedAttachment(
  plaintext: Buffer,
  derivedSecretKey: Uint8Array,
  blossomServerUrl: string,
): Promise<UploadedAttachment> {
  const { ciphertext, key, iv } = encryptAesGcm(plaintext);
  const sha256Hex = createHash("sha256").update(ciphertext).digest("hex");
  const authEvent = buildUploadAuthEvent(sha256Hex, derivedSecretKey);
  const authHeader = Buffer.from(JSON.stringify(authEvent)).toString("base64");

  const res = await fetch(`${blossomServerUrl}/upload`, {
    method: "PUT",
    headers: {
      Authorization: `Nostr ${authHeader}`,
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(ciphertext),
  });

  if (!res.ok) {
    throw new Error(`Blossom upload failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { url?: string; sha256?: string };
  const url = body.url ?? `${blossomServerUrl}/${sha256Hex}`;

  return {
    url,
    sha256: body.sha256 ?? sha256Hex,
    encryptionKey: key.toString("hex"),
    decryptionNonce: iv.toString("hex"),
  };
}

export async function fetchAndDecryptAttachment(
  url: string,
  encryptionKeyHex: string,
  decryptionNonceHex: string,
): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Blossom fetch failed: ${res.status}`);
  }
  const blob = Buffer.from(await res.arrayBuffer());
  return decryptAesGcm(blob, Buffer.from(encryptionKeyHex, "hex"), Buffer.from(decryptionNonceHex, "hex"));
}
