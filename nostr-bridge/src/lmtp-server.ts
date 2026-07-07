import { SMTPServer } from "smtp-server";
import { parseEmail } from "./email-parser.js";
import { lookupNip05Pubkey } from "./nip05.js";
import { UserResolver } from "./user-resolver.js";
import { publishDM } from "./nostr-publisher.js";
import { config } from "./config.js";

class LmtpError extends Error {
  constructor(
    message: string,
    public responseCode: number,
  ) {
    super(message);
  }
}

export function createLmtpServer(userResolver: UserResolver): SMTPServer {
  return new SMTPServer({
    lmtp: true,
    secure: false,
    disabledCommands: ["AUTH", "STARTTLS"],
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        void handleMessage(
          Buffer.concat(chunks),
          session.envelope.rcptTo[0]?.address,
        )
          .then(() => callback())
          .catch((err) => {
            const responseCode =
              err instanceof LmtpError ? err.responseCode : 451;
            const e = new Error(
              err instanceof Error ? err.message : "Internal error",
            ) as Error & {
              responseCode: number;
            };
            e.responseCode = responseCode;
            callback(e);
          });
      });
    },
  });

  async function handleMessage(
    raw: Buffer,
    recipient: string | undefined,
  ): Promise<void> {
    if (!recipient) throw new LmtpError("5.1.1 No recipient", 550);
    const email = await parseEmail(raw);

    let pubkey: string | null;
    try {
      pubkey = await lookupNip05Pubkey(recipient, config.nip05BaseUrl);
    } catch (e) {
      console.error(e);
      throw new LmtpError("4.3.0 NIP-05 lookup failed", 451);
    }

    if (!pubkey) throw new LmtpError("5.1.1 Recipient not registered", 550);

    const { writeRelays, blossomServerUrl } = await userResolver.getPreferences(pubkey);
    try {
      const published = await publishDM(
        config.bridgePrivkey,
        pubkey,
        email,
        writeRelays,
        blossomServerUrl,
      );

      if (!published) throw new Error("Rejected by relays");
    } catch (error) {
      console.error(error);
      throw new LmtpError("4.3.0 Nostr publish failed", 451);
    }
  }
}
