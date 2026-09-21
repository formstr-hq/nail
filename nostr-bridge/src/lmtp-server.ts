import { SMTPServer } from "smtp-server";
import { lookupNip05 } from "./nip05.js";
import { UserResolver } from "./user-resolver.js";
import { publishMail } from "./nostr-publisher.js";
import { stripAttachments } from "./stripAttachments.js";
import { keySigner } from "./protocol/key-signer.js";
import { bytesToMessageString, messageStringToBytes } from "./protocol/bytes.js";
import { config } from "./config.js";

const bridgeSigner = keySigner(config.bridgePrivkey);

export class LmtpError extends Error {
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
          userResolver,
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
}

// Exported (module scope, not a closure over createLmtpServer's userResolver)
// so it can be tested directly against stubbed dependencies rather than
// through the SMTPServer/LMTP transport.
export async function handleMessage(
  raw: Buffer,
  recipient: string | undefined,
  userResolver: UserResolver,
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

  // `raw` is a Buffer (a Uint8Array) — convert to the byte-string
  // representation, NOT text-decode it. Mail declares its own charset in
  // Content-Type; decoding as UTF-8 here would corrupt any message that
  // isn't UTF-8 (ISO-8859-1, Shift-JIS, ...) before the parser ever sees
  // the declared charset. See docs/ARCHITECTURE.md §4.
  const messageRaw = bytesToMessageString(raw);

  const outcome = await publishWithAttachmentFallback(recipient, lookup.pubkey, messageRaw, relays);
  if (outcome === "failed") {
    throw new LmtpError("4.3.0 No relay accepted the message", 451);
  }

  console.log(
    `nostr-bridge: delivered mail for ${recipient} to ${relays.length} relay(s)` +
      (outcome === "stripped" ? " (without attachments)" : ""),
  );
}

/**
 * Publish, and on failure retry once with the attachments stripped.
 *
 * A message carrying a real attachment routinely exceeds the NIP-44 ceiling
 * (§4) or a relay's size cap, and re-publishing the same bytes can only fail
 * the same way. The retry swaps each attachment for an `attachments_error.txt`
 * notice (`stripAttachments.ts`), logs the drop, and gives the mail a chance
 * to arrive. `stripped` is returned so the caller can say so in its log.
 *
 * Never ACK a message that reached no relay: `failed` becomes LMTP 451, so
 * Postfix retries and eventually bounces to the real sender.
 */
async function publishWithAttachmentFallback(
  recipient: string,
  recipientPubkey: string,
  messageRaw: string,
  relays: string[],
): Promise<"full" | "stripped" | "failed"> {
  const publish = async (raw: string): Promise<boolean> => {
    try {
      return await publishMail({ raw, recipientPubkey, signer: bridgeSigner, relays });
    } catch (error) {
      console.error("nostr-bridge: publish threw:", (error as Error).message);
      return false;
    }
  };

  if (await publish(messageRaw)) return "full";

  let stripped: string | null = null;
  try {
    stripped = await stripAttachments(Buffer.from(messageStringToBytes(messageRaw)));
  } catch (error) {
    console.error("nostr-bridge: stripping attachments failed:", (error as Error).message);
  }
  if (stripped === null) return "failed";

  console.warn(
    `nostr-bridge: no relay accepted mail for ${recipient}; retrying without attachments`,
  );
  return (await publish(stripped)) ? "stripped" : "failed";
}
