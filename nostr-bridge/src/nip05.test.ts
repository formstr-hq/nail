import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { lookupNip05 } from "./nip05.js";

const PUBKEY = "a".repeat(64);
const TENANT = "acme-test.com";
const PLATFORM = "mailstr.app";
const RESOLVER = "https://api.staging.test";

function mockFetch(impl: (url: string) => Promise<Response> | Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => impl(String(input))),
  );
}

const ok = (names: Record<string, string>) =>
  new Response(JSON.stringify({ names }));

beforeEach(() => {
  // Resolver configured by default; individual tests override.
  process.env.NIP05_RESOLVER_URL = RESOLVER;
  delete process.env.NIP05_RESOLVER_KEY;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NIP05_RESOLVER_URL;
  delete process.env.NIP05_RESOLVER_KEY;
});

describe("lookupNip05 — platform domains", () => {
  it("returns the pubkey when the name is registered", async () => {
    mockFetch(() => ok({ alice: PUBKEY }));
    expect(await lookupNip05(`alice@${PLATFORM}`)).toEqual({
      status: "found",
      pubkey: PUBKEY,
    });
  });

  it("normalizes the localpart before lookup", async () => {
    const f = vi.fn((_input: RequestInfo | URL) => ok({ alice: PUBKEY }));
    vi.stubGlobal("fetch", f);
    await lookupNip05(`Alice+news@${PLATFORM}`);
    expect(String(f.mock.calls[0][0])).toContain("name=alice");
  });

  it("returns not-found for an unregistered name", async () => {
    mockFetch((url) =>
      url.includes("/api/nip-05/resolve")
        ? new Response("", { status: 404 })
        : ok({}),
    );
    expect(await lookupNip05(`nobody@${PLATFORM}`)).toEqual({
      status: "not-found",
    });
  });

  it("returns not-found on 404", async () => {
    mockFetch((url) =>
      url.includes("/api/nip-05/resolve")
        ? new Response("", { status: 404 })
        : new Response("", { status: 404 }),
    );
    expect(await lookupNip05(`nobody@${PLATFORM}`)).toEqual({
      status: "not-found",
    });
  });

  // Must NOT collapse into not-found: a 500 is retryable (451), an absent
  // name is permanent (550). See §6A step 2.
  it("returns error on a 500", async () => {
    mockFetch(() => new Response("", { status: 500 }));
    expect((await lookupNip05(`alice@${PLATFORM}`)).status).toBe("error");
  });

  it("returns error when the network throws", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    expect((await lookupNip05(`alice@${PLATFORM}`)).status).toBe("error");
  });

  it("returns error for an address with no @", async () => {
    expect((await lookupNip05("alice")).status).toBe("error");
  });

  it("still resolves via the well-known when no resolver is configured", async () => {
    delete process.env.NIP05_RESOLVER_URL;
    mockFetch(() => ok({ alice: PUBKEY }));
    expect(await lookupNip05(`alice@${PLATFORM}`)).toEqual({
      status: "found",
      pubkey: PUBKEY,
    });
  });

  it("reports not-found on a 404 even with no resolver configured", async () => {
    delete process.env.NIP05_RESOLVER_URL;
    mockFetch(() => new Response("", { status: 404 }));
    expect(await lookupNip05(`nobody@${PLATFORM}`)).toEqual({
      status: "not-found",
    });
  });
});

describe("lookupNip05 — tenant (workspace) domains", () => {
  // The whole reason the resolver fallback exists: a tenant domain has no web
  // server, so the direct well-known fetch fails outright.
  it("falls back to the resolver when the domain serves no well-known", async () => {
    mockFetch((url) =>
      url.includes("/api/nip-05/resolve")
        ? new Response(JSON.stringify({ pubkey: PUBKEY }))
        : Promise.reject(new Error("ENOTFOUND")),
    );
    expect(await lookupNip05(`alice@${TENANT}`)).toEqual({
      status: "found",
      pubkey: PUBKEY,
    });
  });

  it("passes the full address to the resolver endpoint", async () => {
    const f = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/nip-05/resolve")) {
        return new Response(JSON.stringify({ pubkey: PUBKEY }));
      }
      return Promise.reject(new Error("ENOTFOUND"));
    });
    vi.stubGlobal("fetch", f);

    await lookupNip05(`Alice@${TENANT}`);
    const resolverCall = f.mock.calls
      .map((c) => String(c[0]))
      .find((u) => u.includes("/api/nip-05/resolve"));
    expect(resolverCall).toContain(encodeURIComponent(`Alice@${TENANT}`));
  });

  // The load-bearing failure policy: a resolver outage must defer (451), not
  // bounce — bouncing real mail is unrecoverable.
  it("returns error (not not-found) when the resolver is down", async () => {
    mockFetch((url) =>
      url.includes("/api/nip-05/resolve")
        ? Promise.reject(new Error("ECONNREFUSED"))
        : new Response("", { status: 502 }),
    );
    expect((await lookupNip05(`alice@${TENANT}`)).status).toBe("error");
  });

  it("returns not-found only when the resolver says 404", async () => {
    mockFetch((url) =>
      url.includes("/api/nip-05/resolve")
        ? new Response("", { status: 404 })
        : Promise.reject(new Error("ENOTFOUND")),
    );
    expect(await lookupNip05(`ghost@${TENANT}`)).toEqual({
      status: "not-found",
    });
  });

  it("returns error when no resolver is configured — cannot resolve at all", async () => {
    delete process.env.NIP05_RESOLVER_URL;
    mockFetch(() => Promise.reject(new Error("ENOTFOUND")));
    expect((await lookupNip05(`alice@${TENANT}`)).status).toBe("error");
  });

  it("uses the resolver when the domain answers 200 with a non-NIP-05 body", async () => {
    // An SPA fallback answers 200 HTML for every path.
    mockFetch((url) =>
      url.includes("/api/nip-05/resolve")
        ? new Response(JSON.stringify({ pubkey: PUBKEY }))
        : new Response("<html>not json</html>", { status: 200 }),
    );
    expect(await lookupNip05(`alice@${TENANT}`)).toEqual({
      status: "found",
      pubkey: PUBKEY,
    });
  });

  it("prefers a well-known hit over the resolver", async () => {
    const OTHER = "b".repeat(64);
    mockFetch((url) =>
      url.includes("/api/nip-05/resolve")
        ? new Response(JSON.stringify({ pubkey: OTHER }))
        : ok({ alice: PUBKEY }),
    );
    expect(await lookupNip05(`alice@${TENANT}`)).toEqual({
      status: "found",
      pubkey: PUBKEY,
    });
  });

  it("resolves through the resolver when the well-known omits the name", async () => {
    mockFetch((url) =>
      url.includes("/api/nip-05/resolve")
        ? new Response(JSON.stringify({ pubkey: PUBKEY }))
        : ok({ someoneelse: "c".repeat(64) }),
    );
    expect(await lookupNip05(`alice@${TENANT}`)).toEqual({
      status: "found",
      pubkey: PUBKEY,
    });
  });

  it("sends a bearer key when the resolver key is configured", async () => {
    process.env.NIP05_RESOLVER_KEY = "secret-key";
    const f = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) => {
        void init;
        return new Response(JSON.stringify({ pubkey: PUBKEY }));
      },
    );
    vi.stubGlobal("fetch", f);
    await lookupNip05(`alice@${TENANT}`);
    const resolverInit = f.mock.calls.at(-1)?.[1] as RequestInit | undefined;
    expect(
      (resolverInit?.headers as Record<string, string>)?.authorization,
    ).toBe("Bearer secret-key");
  });
});
