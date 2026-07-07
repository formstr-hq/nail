import { simpleParser } from "mailparser";

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ParsedEmail {
  from: string;
  subject: string;
  text: string;
  date: Date;
  attachments: ParsedAttachment[];
}

export async function parseEmail(raw: Buffer): Promise<ParsedEmail> {
  const parsed = await simpleParser(raw);
  return {
    from: parsed.from?.value[0]?.address ?? "unknown@unknown",
    subject: parsed.subject ?? "",
    text: parsed.text ?? "",
    date: parsed.date ?? new Date(),
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? "attachment",
      contentType: a.contentType,
      content: a.content,
    })),
  };
}
