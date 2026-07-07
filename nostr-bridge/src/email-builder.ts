export interface OutboundAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface OutboundMessage {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutboundAttachment[];
}

export function buildMailOptions(message: OutboundMessage): {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: OutboundAttachment[];
} {
  return {
    from: message.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
    attachments: message.attachments?.map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
    })),
  };
}
