import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";

vi.hoisted(() => {
  process.env.LOCAL_DOMAINS = "mailstr.app";
  process.env.NOSTR_BRIDGE_NSEC = "11".repeat(32);
});

import {
  answer,
  createSocketmapServer,
  decodeNetstring,
  encodeNetstring,
  parseRequest,
  SOCKETMAP_MAPS,
  type DomainDirectory,
  type ResponderOptions,
} from "./socketmap.js";
import { BackendDomainDirectory } from "./domain-directory.js";

const TRANSPORT = "nostr-bridge:2400";

function makeDirectory(managed: string[], opts?: { fail?: boolean }): DomainDirectory {
  return {
    isManagedDomain: vi.fn(async (domain: string) => {
      if (opts?.fail) throw new Error("directory down");
      return managed.includes(domain.toLowerCase());
    }),
    refresh: vi.fn(async () => {}),
  };
}

function options(directory: DomainDirectory): ResponderOptions {
  return { directory, platformDomains: [], transportNexthop: TRANSPORT };
}

describe("netstring framing", () => {
  it("round-trips a payload", () => {
    const encoded = encodeNetstring("OK example.com");
    const decoded = decodeNetstring(encoded);
    expect(decoded?.payload).toBe("OK example.com");
    expect(decoded?.rest.length).toBe(0);
  });

  it("encodes byte length, not character count", () => {
    // "é" is two UTF-8 bytes; a length in characters would desync Postfix.
    const encoded = encodeNetstring("é");
    expect(encoded.toString("utf8").startsWith("2:")).toBe(true);
  });

  it("returns null on a partial netstring", () => {
    expect(decodeNetstring(Buffer.from("10:OK examp"))).toBeNull();
    expect(decodeNetstring(Buffer.from("3:OK"))).toBeNull();
  });

  it("parses <mapname> <key>, preserving spaces in the key", () => {
    expect(parseRequest("relay_domains example.com")).toEqual({
      mapName: "relay_domains",
      key: "example.com",
    });
    expect(parseRequest("relay_recipients user@example.com")).toEqual({
      mapName: "relay_recipients",
      key: "user@example.com",
    });
    expect(parseRequest("no-space")).toBeNull();
  });
});

describe("answer", () => {
  it("relay_domains: OK for a managed tenant", async () => {
    const reply = await answer(
      { mapName: SOCKETMAP_MAPS.relayDomains, key: "acme.com" },
      options(makeDirectory(["acme.com"])),
    );
    expect(reply).toEqual({ kind: "ok", data: "acme.com" });
  });

  it("relay_domains: NOTFOUND for an unknown domain", async () => {
    const reply = await answer(
      { mapName: SOCKETMAP_MAPS.relayDomains, key: "random.tld" },
      options(makeDirectory(["acme.com"])),
    );
    expect(reply.kind).toBe("notfound");
  });

  it("relay_domains: matches case-insensitively", async () => {
    const reply = await answer(
      { mapName: SOCKETMAP_MAPS.relayDomains, key: "ACME.com" },
      options(makeDirectory(["acme.com"])),
    );
    expect(reply.kind).toBe("ok");
  });

  it("relay_recipients: accepts any localpart for a managed domain", async () => {
    const reply = await answer(
      { mapName: SOCKETMAP_MAPS.relayRecipients, key: "anyone@acme.com" },
      options(makeDirectory(["acme.com"])),
    );
    expect(reply).toEqual({ kind: "ok", data: "anyone@acme.com" });
  });

  it("transport: returns LMTP into the bridge for a managed domain", async () => {
    const reply = await answer(
      { mapName: SOCKETMAP_MAPS.transport, key: "acme.com" },
      options(makeDirectory(["acme.com"])),
    );
    expect(reply).toEqual({ kind: "ok", data: `lmtp:inet:${TRANSPORT}` });
  });

  it("answers NOTFOUND for map names it does not serve", async () => {
    const reply = await answer(
      { mapName: "something_else", key: "acme.com" },
      options(makeDirectory(["acme.com"])),
    );
    expect(reply.kind).toBe("notfound");
  });

  // unionmap concatenates results from every matching table, so answering for
  // a domain mailcow's own maps already cover would corrupt the value (e.g. a
  // doubled transport). Platform domains must get NOTFOUND from us.
  it("answers NOTFOUND for a platform domain so unionmap does not concatenate", async () => {
    const opts = {
      ...options(makeDirectory(["mailstr.app"])),
      platformDomains: ["mailstr.app"],
    };
    for (const mapName of [
      SOCKETMAP_MAPS.relayDomains,
      SOCKETMAP_MAPS.relayRecipients,
      SOCKETMAP_MAPS.transport,
    ]) {
      const reply = await answer({ mapName, key: "alice@mailstr.app" }, opts);
      expect(reply.kind).toBe("notfound");
    }
  });

  // The load-bearing failure policy: an outage must defer, never bounce.
  it("TEMP when the directory throws — Postfix must retry, not bounce", async () => {
    const reply = await answer(
      { mapName: SOCKETMAP_MAPS.relayDomains, key: "acme.com" },
      options(makeDirectory([], { fail: true })),
    );
    expect(reply.kind).toBe("temp");
  });

  it("uses the full address as the key for recipient lookups", async () => {
    const directory = makeDirectory(["acme.com"]);
    await answer(
      { mapName: SOCKETMAP_MAPS.relayRecipients, key: "bob+tag@acme.com" },
      options(directory),
    );
    // Domain extraction must ignore the "+tag" and lowercase the domain.
    expect(directory.isManagedDomain).toHaveBeenCalledWith("acme.com");
  });
});

describe("socketmap server", () => {
  let server: net.Server;
  let port: number;
  let directory: DomainDirectory;

  beforeEach(async () => {
    directory = makeDirectory(["acme.com"]);
    server = createSocketmapServer(options(directory));
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  /** Send one request, return the decoded reply. */
  async function ask(mapName: string, key: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      const chunks: Buffer[] = [];
      socket.on("connect", () => socket.write(encodeNetstring(`${mapName} ${key}`)));
      socket.on("data", (c) => chunks.push(c));
      socket.on("end", () => {
        const decoded = decodeNetstring(Buffer.concat(chunks));
        if (!decoded) reject(new Error("no decodable reply"));
        else resolve(decoded.payload);
      });
      socket.on("error", reject);
    });
  }

  it("answers a managed domain with OK over the wire", async () => {
    await expect(ask("relay_domains", "acme.com")).resolves.toBe("OK acme.com");
  });

  it("answers an unknown domain with NOTFOUND over the wire", async () => {
    await expect(ask("relay_domains", "nope.tld")).resolves.toBe("NOTFOUND ");
  });

  it("answers TEMP over the wire when the directory fails", async () => {
    directory = makeDirectory([], { fail: true });
    server.close();
    server = createSocketmapServer(options(directory));
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    port = (server.address() as AddressInfo).port;

    await expect(ask("relay_domains", "acme.com")).resolves.toMatch(/^TEMP /);
  });
});

describe("BackendDomainDirectory", () => {
  const baseCfg = {
    platformDomains: ["mailstr.app"],
    directoryUrl: "https://backend.test/api/domains/managed",
    ttlMs: 60_000,
    negativeTtlMs: 60_000,
    maxStaleMs: 60_000,
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats platform domains as managed without any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const dir = new BackendDomainDirectory(baseCfg);
    await expect(dir.isManagedDomain("mailstr.app")).resolves.toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("loads tenant domains from the backend and caches them", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ domains: ["acme.com"] }), { status: 200 }),
    );
    const dir = new BackendDomainDirectory(baseCfg);

    await expect(dir.isManagedDomain("acme.com")).resolves.toBe(true);
    // Second lookup is answered from cache.
    await expect(dir.isManagedDomain("acme.com")).resolves.toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("negative-caches an unknown domain", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ domains: ["acme.com"] }), { status: 200 }),
    );
    const dir = new BackendDomainDirectory(baseCfg);

    await expect(dir.isManagedDomain("nope.tld")).resolves.toBe(false);
    await expect(dir.isManagedDomain("nope.tld")).resolves.toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  // Availability policy: stale data beats no data, and a never-loaded
  // directory must surface as an error so the socketmap can answer TEMP.
  it("keeps serving last-known-good domains when the backend starts failing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ domains: ["acme.com"] }), { status: 200 }),
    );
    const dir = new BackendDomainDirectory({ ...baseCfg, maxStaleMs: 0 });

    await expect(dir.isManagedDomain("acme.com")).resolves.toBe(true);

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await dir.refresh().catch(() => {});
    await expect(dir.isManagedDomain("acme.com")).resolves.toBe(true);
  });

  it("propagates failure when it has never loaded", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    const dir = new BackendDomainDirectory(baseCfg);
    await expect(dir.refresh()).rejects.toThrow("ECONNREFUSED");
  });

  it("rejects a malformed backend response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ oops: true }), { status: 200 }),
    );
    const dir = new BackendDomainDirectory(baseCfg);
    await expect(dir.refresh()).rejects.toThrow("domains[]");
  });
});
