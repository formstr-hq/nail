import { SMTPServer } from "smtp-server";
import { lookupNip05 } from "./nip05.js";
import { UserResolver } from "./user-resolver.js";
import { publishMail } from "./nostr-publisher.js";
import { keySigner } from "./protocol/key-signer.js";
import { config } from "./config.js";

const bridgeSigner = keySigner(config.bridgePrivkey);

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

    const lookup = await lookupNip05(recipient, config.nip05BaseUrl);

    // Permanent vs transient must stay distinct: 550 bounces to the real
    // sender, 451 makes Postfix retry. Treating an outage as 550 loses mail.
    if (lookup.status === "error") {
      console.error(`nostr-bridge: NIP-05 lookup failed for ${recipient}: ${lookup.message}`);
      throw new LmtpError("4.3.0 NIP-05 lookup failed", 451);
    }
    if (lookup.status === "not-found") {
      throw new LmtpError("5.1.1 Recipient not registered", 550);
    }

    const relays = await userResolver.getDmRelays(lookup.pubkey);

    let published: boolean;
    try {
      published = await publishMail({
        raw: raw.toString("utf8"),
        recipientPubkey: lookup.pubkey,
        signer: bridgeSigner,
        relays,
      });
    } catch (error) {
      console.error("nostr-bridge: publish threw:", (error as Error).message);
      throw new LmtpError("4.3.0 Nostr publish failed", 451);
    }

    // Never ACK a message that reached no relay — a 250 tells the peer it was
    // delivered and it is then gone forever.
    if (!published) throw new LmtpError("4.3.0 No relay accepted the message", 451);

    console.log(`nostr-bridge: delivered mail for ${recipient} to ${relays.length} relay(s)`);
  }
}
