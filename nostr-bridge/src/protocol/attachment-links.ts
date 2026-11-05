/**
 * The `attachments.txt` wire format shared by the bridge and the client.
 *
 * A message whose files were encrypted and uploaded to Blossom carries their
 * links in one real text attachment, so both Mailstr readers and ordinary
 * mail clients can see that attachments exist. The client parses this block
 * back into attachment chips; the container file itself is never shown.
 */
export interface AttachmentShareLink {
  filename: string;
  url: string;
}

export const ATTACHMENT_LINKS_START = "--- Mailstr attachments ---";
export const ATTACHMENT_LINKS_END = "--- End Mailstr attachments ---";
export const ATTACHMENTS_TXT_FILENAME = "attachments.txt";

export function formatAttachmentLinks(links: readonly AttachmentShareLink[]): string {
  if (links.length === 0) return "";
  const lines = links.map((link) => `- ${link.filename}: ${link.url}`);
  return `${ATTACHMENT_LINKS_START}\n${lines.join("\n")}\n${ATTACHMENT_LINKS_END}\n`;
}

export function isAttachmentLinksFile(filename: string | null | undefined): boolean {
  return (filename ?? "").toLowerCase() === ATTACHMENTS_TXT_FILENAME;
}
