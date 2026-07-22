/**
 * NIP-92 `imeta` tags, the wire format for attachments too large to inline.
 *
 * Lives in the protocol module because both sides parse it: the bridge reads
 * what a client sent, and the client reads what the bridge sent. A second copy
 * on either side is how the two silently drift apart.
 *
 * `decryption-key` and `decryption-nonce` are absent for attachments hosted in
 * the clear, so both are optional and callers must handle either shape.
 */
export interface ImetaAttachment {
  url: string;
  filename: string;
  mimeType: string;
  encryptionKey: string | undefined;
  decryptionNonce: string | undefined;
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
      return {
        url: fields["url"] ?? "",
        filename: fields["filename"] ?? "attachment",
        mimeType: fields["m"] ?? "application/octet-stream",
        encryptionKey: fields["decryption-key"],
        decryptionNonce: fields["decryption-nonce"],
      };
    })
    .filter((a) => a.url !== "");
}
