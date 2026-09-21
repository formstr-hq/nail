import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";

// Same load-order constraint as lmtp-server.test.ts: config.ts reads the env
// at import time. MAX_MESSAGE_BYTES is set low here so the guard can be
// exercised without buffering tens of megabytes in the test.
vi.hoisted(() => {
  process.env.LOCAL_DOMAINS = "mailstr.app";
  process.env.NOSTR_BRIDGE_NSEC = "11".repeat(32);
  process.env.MAIL_MAX_BYTES = "4096";
});

vi.mock("./nip05.js", () => ({ lookupNip05: vi.fn() }));
vi.mock("./nostr-publisher.js", () => ({ publishMail: vi.fn() }));

import { createLmtpServer } from "./lmtp-server.js";
import { lookupNip05 } from "./nip05.js";
import { publishMail } from "./nostr-publisher.js";
import { UserResolver } from "./user-resolver.js";

const mockedLookup = vi.mocked(lookupNip05);
const mockedPublish = vi.mocked(publishMail);

function makeResolver(): UserResolver {
  const resolver = new UserResolver([], [], 10, 1000);
  vi.spyOn(resolver, "getDmRelays").mockResolvedValue(["wss://relay.example"]);
  return resolver;
}

/**
 * A minimal line-based LMTP client driving the real server. The guard under
 * test lives in `createLmtpServer`'s `onData` handling, so it cannot be
 * reached by calling `handleMessage` directly.
 *
 * Reads a complete reply (all `250-` continuation lines plus the final
 * `250 ` line) before sending the next command, exactly as a real client
 * does — treating each line as a reply is what makes LHLO appear to have
 * produced five separate responses.
 */
class LmtpClient {
  private buffer = "";
  private waiters: ((line: string) => void)[] = [];
  private lines: string[] = [];
  lastReply = "";

  constructor(private socket: net.Socket) {
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf("\r\n")) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 2);
        const waiter = this.waiters.shift();
        if (waiter) waiter(line);
        else this.lines.push(line);
      }
    });
  }

  private nextLine(): Promise<string> {
    const queued = this.lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Consumes the server greeting; commands sent before it arrive too soon. */
  async greeting(): Promise<string> {
    const line = await this.nextLine();
    this.lastReply = line;
    return line;
  }

  /** Sends `command` and resolves with the complete reply, joined by newlines. */
  async command(command: string): Promise<string> {
    this.socket.write(command + "\r\n");
    const lines = [await this.nextLine()];
    // A final reply line has a space after the three-digit code; continuations
    // ("250-...") keep coming.
    while (/^\d{3}-/.test(lines.at(-1)!)) lines.push(await this.nextLine());
    this.lastReply = lines.at(-1)!;
    return lines.join("\n");
  }

  /** Sends the whole DATA block (headers, body, CRLF-dot-CRLF). */
  async sendData(message: string): Promise<string> {
    this.socket.write(message + "\r\n.\r\n");
    const line = await this.nextLine();
    this.lastReply = line;
    return line;
  }
}

async function withLmtp(run: (client: LmtpClient) => Promise<void>): Promise<void> {
  const server = createLmtpServer(makeResolver());
  // SMTPServer.listen returns the underlying net.Server.
  const netServer = server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => netServer.once("listening", resolve));
  const port = (netServer.address() as AddressInfo).port;
  const socket = net.connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const client = new LmtpClient(socket);
  try {
    await client.greeting();
    await run(client);
  } finally {
    socket.destroy();
    netServer.close();
  }
}

async function deliver(client: LmtpClient, message: string): Promise<string> {
  await client.command("LHLO test");
  await client.command("MAIL FROM:<bob@example.com>");
  await client.command("RCPT TO:<alice@mailstr.app>");
  await client.command("DATA");
  return client.sendData(message);
}

const SMALL = [
  "From: bob@example.com",
  "To: alice@mailstr.app",
  "Subject: small",
  "",
  "hello",
].join("\r\n");

describe("LMTP message size guard", () => {
  beforeEach(() => {
    mockedLookup.mockReset();
    mockedPublish.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a message under the cap", async () => {
    mockedLookup.mockResolvedValue({ status: "found", pubkey: "a".repeat(64) });
    mockedPublish.mockResolvedValue(true);

    await withLmtp(async (client) => {
      const reply = await deliver(client, SMALL);
      expect(reply).toMatch(/^250/);
    });

    expect(mockedPublish).toHaveBeenCalledTimes(1);
  });

  it("rejects an over-cap message with 552 and never publishes it", async () => {
    const huge = [
      "From: bob@example.com",
      "To: alice@mailstr.app",
      "Subject: huge",
      "",
      "x".repeat(10_000),
    ].join("\r\n");

    await withLmtp(async (client) => {
      const reply = await deliver(client, huge);
      expect(reply).toMatch(/^552/);
      expect(reply).toContain("too large");
    });

    // The guard rejects before lookup/publish: an oversized message never
    // reaches the NIP-44 encrypt and cannot OOM the process.
    expect(mockedLookup).not.toHaveBeenCalled();
    expect(mockedPublish).not.toHaveBeenCalled();
  });
});
