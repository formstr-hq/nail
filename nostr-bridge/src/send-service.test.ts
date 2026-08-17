import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// config.ts is imported transitively; it throws at load without these and
// parses NOSTR_BRIDGE_NSEC eagerly. Same shape as lmtp-server.test.ts.
vi.hoisted(() => {
  process.env.LOCAL_DOMAINS = "mailstr.app";
  process.env.NOSTR_BRIDGE_NSEC = "11".repeat(32);
});

vi.mock("./nip05.js", () => ({ lookupNip05: vi.fn() }));
vi.mock("./nostr-publisher.js", () => ({ publishMail: vi.fn() }));

import { nip19 } from "nostr-tools";
import {
  resolveRecipient,
  sendSystemMail,
  createSendApp,
  type SendDeps,
} from "./send-service.js";
import { lookupNip05 } from "./nip05.js";
import { publishMail } from "./nostr-publisher.js";
import { keySigner } from "./protocol/key-signer.js";

const mockedLookup = vi.mocked(lookupNip05);
const mockedPublish = vi.mocked(publishMail);

const PUBKEY = "a".repeat(64);
const NPUB = nip19.npubEncode(PUBKEY);
const signer = keySigner(new Uint8Array(32).fill(0x11));

function deps(overrides: Partial<SendDeps> = {}): SendDeps {
  return {
    signer,
    userResolver: { getDmRelays: vi.fn().mockResolvedValue(["wss://relay.example"]) },
    localDomains: ["mailstr.app"],
    nip05BaseUrl: undefined,
    ...overrides,
  };
}

beforeEach(() => {
  mockedLookup.mockReset();
  mockedPublish.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRecipient", () => {
  it("decodes an npub to its hex pubkey without any NIP-05 lookup", async () => {
    const result = await resolveRecipient(NPUB);
    expect(result).toEqual({ ok: true, pubkey: PUBKEY });
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("passes a hex pubkey straight through", async () => {
    expect(await resolveRecipient(PUBKEY)).toEqual({ ok: true, pubkey: PUBKEY });
    expect(mockedLookup).not.toHaveBeenCalled();
  });

  it("resolves an address through NIP-05", async () => {
    mockedLookup.mockResolvedValue({ status: "found", pubkey: PUBKEY });
    expect(await resolveRecipient("alice@mailstr.app")).toEqual({
      ok: true,
      pubkey: PUBKEY,
      address: "alice@mailstr.app",
    });
  });

  it("returns 404 for an unregistered address, 502 for a lookup outage", async () => {
    mockedLookup.mockResolvedValueOnce({ status: "not-found" });
    expect(await resolveRecipient("ghost@mailstr.app")).toMatchObject({ ok: false, status: 404 });

    mockedLookup.mockResolvedValueOnce({ status: "error", message: "ECONNREFUSED" });
    expect(await resolveRecipient("alice@mailstr.app")).toMatchObject({ ok: false, status: 502 });
  });

  it("rejects malformed recipients with 400", async () => {
    expect(await resolveRecipient("not-an-address")).toMatchObject({ ok: false, status: 400 });
  });
});

describe("sendSystemMail", () => {
  it("rejects missing fields with 400", async () => {
    expect(await sendSystemMail(deps(), { to: "", subject: "s", text: "t" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await sendSystemMail(deps(), { to: PUBKEY, subject: "", text: "t" })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await sendSystemMail(deps(), { to: PUBKEY, subject: "s" })).toMatchObject({
      ok: false,
      status: 400,
    });
  });

  it("refuses a From on a domain the bridge does not serve", async () => {
    const result = await sendSystemMail(deps(), {
      to: PUBKEY,
      from: "evil@elsewhere.com",
      subject: "s",
      text: "t",
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(mockedPublish).not.toHaveBeenCalled();
  });

  it("defaults From to postmaster@<domain> and publishes a composed message", async () => {
    mockedPublish.mockResolvedValue(true);
    const result = await sendSystemMail(deps(), {
      to: PUBKEY,
      subject: "Welcome",
      text: "hello there",
    });
    expect(result).toEqual({ ok: true, pubkey: PUBKEY, relays: 1 });

    const raw = mockedPublish.mock.calls[0][0].raw;
    expect(raw).toContain("From: postmaster@mailstr.app");
    expect(raw).toContain("Subject: Welcome");
    expect(raw).toContain("hello there");
    expect(mockedPublish.mock.calls[0][0].recipientPubkey).toBe(PUBKEY);
  });

  it("preserves a display-named From whose address is on a served domain", async () => {
    mockedPublish.mockResolvedValue(true);
    await sendSystemMail(deps(), {
      to: PUBKEY,
      from: "Mail by Formstr <hello@mailstr.app>",
      subject: "s",
      text: "t",
    });
    expect(mockedPublish.mock.calls[0][0].raw).toContain(
      "From: Mail by Formstr <hello@mailstr.app>",
    );
  });

  it("returns 502 when no relay accepts the publish", async () => {
    mockedPublish.mockResolvedValue(false);
    expect(await sendSystemMail(deps(), { to: PUBKEY, subject: "s", text: "t" })).toMatchObject({
      ok: false,
      status: 502,
    });
  });
});

describe("createSendApp auth", () => {
  async function withServer(fn: (baseUrl: string) => Promise<void>) {
    const app = createSendApp({ ...deps(), apiKey: "secret-key" });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      await fn(`http://127.0.0.1:${port}`);
    } finally {
      server.close();
    }
  }

  const body = JSON.stringify({ to: PUBKEY, subject: "s", text: "t" });
  const send = (baseUrl: string, auth?: string) =>
    fetch(`${baseUrl}/v1/send`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
      body,
    });

  it("401s without a bearer token and with the wrong key", async () => {
    await withServer(async (baseUrl) => {
      expect((await send(baseUrl)).status).toBe(401);
      expect((await send(baseUrl, "Bearer wrong-key")).status).toBe(401);
      expect(mockedPublish).not.toHaveBeenCalled();
    });
  });

  it("202s with the correct key", async () => {
    mockedPublish.mockResolvedValue(true);
    await withServer(async (baseUrl) => {
      const res = await send(baseUrl, "Bearer secret-key");
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ published: true, relays: 1 });
    });
  });
});
