import type { Event, UnsignedEvent } from "nostr-tools";
import type { FileSigner } from "@formstr/drive-sdk";

/**
 * Blossom BUD pinning is an additive `["p", pubkey]` tag on the upload
 * authorization. Servers that do not implement it ignore the unknown tag, so
 * the same upload remains valid everywhere.
 *
 * The tag is only added to upload tokens; delete/get tokens use the caller's
 * normal authorization.
 */
export function pinUploadSigner(
  signer: FileSigner,
  pinTo: string | undefined,
): FileSigner {
  if (!pinTo) return signer;
  return {
    getPublicKey: () => signer.getPublicKey(),
    signEvent: async (template: UnsignedEvent): Promise<Event> => {
      const tags = [...(template.tags ?? [])];
      const isUpload = tags.some((tag) => tag[0] === "t" && tag[1] === "upload");
      if (isUpload && !tags.some((tag) => tag[0] === "p" && tag[1] === pinTo)) {
        tags.push(["p", pinTo]);
      }
      return signer.signEvent({ ...template, tags });
    },
  };
}
