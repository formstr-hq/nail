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
