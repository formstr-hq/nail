import { ImapFlow } from "imapflow";
import { simpleParser, ParsedMail } from "mailparser";
import { config } from "./config.js";

export interface MailMessage {
  uid: number;
  from: string;
  subject: string;
  date: Date;
  text: string;
}

function formatMail(parsed: ParsedMail): string {
  const from = parsed.from?.text || "Unknown sender";
  const subject = parsed.subject || "(no subject)";
  const date = parsed.date?.toISOString() || "Unknown date";
  const body = parsed.text || parsed.html || "(empty body)";

  return [
    `From: ${from}`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    ``,
    body,
  ].join("\n");
}

export async function fetchUnseenMails(): Promise<MailMessage[]> {
  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.tls,
    auth: {
      user: config.imap.user,
      pass: config.imap.password,
    },
    logger: false,
  });

  const messages: MailMessage[] = [];

  try {
    await client.connect();
    console.log(`Connected to IMAP server ${config.imap.host}`);

    const lock = await client.getMailboxLock("INBOX");
    try {
      // Fetch all unseen messages
      for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
        const parsed = await simpleParser(msg.source);
        messages.push({
          uid: msg.uid,
          from: parsed.from?.text || "Unknown",
          subject: parsed.subject || "(no subject)",
          date: parsed.date || new Date(),
          text: formatMail(parsed),
        });
      }

      // Mark fetched messages as seen
      if (messages.length > 0) {
        const uids = messages.map((m) => m.uid.toString()).join(",");
        await client.messageFlagsAdd({ uid: uids }, ["\\Seen"]);
        console.log(`Marked ${messages.length} message(s) as seen`);
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err) {
    console.error("IMAP error:", err);
    throw err;
  }

  return messages;
}
