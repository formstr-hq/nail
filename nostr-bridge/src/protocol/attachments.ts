/**
 * NIP-92 `imeta` tags for attachments too large to inline.
 *
 * This parser is read-only. New inbound mail carries drive share links in
 * `attachments.txt`; `imeta` stays because mail already on relays still uses
 * it. Two encrypted shapes are recognized, distinguished by which fields are
 * present:
 *
 *  - NIP-FS / drive-sdk format: `x` (ciphertext sha256), `ox` (plaintext
 *    sha256), `size` (plaintext length) and `decryption-key`; `decryption-nonce`
 *    is absent. The blob is segmented AES-256-GCM whose nonces are derived from
 *    the segment index.
 *  - Legacy one-shot AES-256-GCM (what the bridge used to write):
 *    `decryption-key` and `decryption-nonce` are present.
 *  - Neither key present: hosted in the clear, which `imeta` permits.
 */
export interface ImetaAttachment {
  url: string;
  filename: string;
  mimeType: string;
  encryptionKey: string | undefined;
  decryptionNonce: string | undefined;
  /** sha256 of the ciphertext blob as stored on Blossom. NIP-FS format only. */
  blobHash: string | undefined;
  /** sha256 of the plaintext file, checked after decryption. NIP-FS only. */
  unencryptedFileHash: string | undefined;
  /** Plaintext byte length. NIP-FS only — required to find the final segment. */
  size: number | undefined;
}

export function parseImetaTags(tags: string[][]): ImetaAttachment[] {
  return tags
    .filter((t) => t[0] === "imeta")
    .map((t) => {
      const fields: Record<string, string> = {};
      for (const entry of t.slice(1)) {
        const spaceIdx = entry.indexOf(" ");
        if (spaceIdx !== -1) {
          fields[entry.slice(0, spaceIdx)] = entry.slice(spaceIdx + 1);
        }
      }
      const size = fields["size"] !== undefined ? Number(fields["size"]) : undefined;
      return {
        url: fields["url"] ?? "",
        filename: fields["filename"] ?? "attachment",
        mimeType: fields["m"] ?? "application/octet-stream",
        encryptionKey: fields["decryption-key"],
        decryptionNonce: fields["decryption-nonce"],
        blobHash: fields["x"],
        unencryptedFileHash: fields["ox"],
        size: size !== undefined && Number.isFinite(size) ? size : undefined,
      };
    })
    .filter((a) => a.url !== "");
}
