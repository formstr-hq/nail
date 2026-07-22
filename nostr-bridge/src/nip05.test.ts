import { describe, it, expect, vi, afterEach } from "vitest";
import { lookupNip05 } from "./nip05.js";

const PUBKEY = "a".repeat(64);

function mockFetch(impl: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => vi.unstubAllGlobals());

describe("lookupNip05", () => {
  it("returns the pubkey when the name is registered", async () => {
    mockFetch(() => new Response(JSON.stringify({ names: { alice: PUBKEY } })));
    expect(await lookupNip05("alice@mailstr.app")).toEqual({
      status: "found", pubkey: PUBKEY,
    });
  });

  it("normalizes the localpart before lookup", async () => {
    const f = vi.fn(() => new Response(JSON.stringify({ names: { alice: PUBKEY } })));
    vi.stubGlobal("fetch", f);
    await lookupNip05("Alice+news@mailstr.app");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(String((f as any).mock.calls[0][0])).toContain("name=alice");
  });

  it("returns not-found for an unregistered name", async () => {
    mockFetch(() => new Response(JSON.stringify({ names: {} })));
    expect(await lookupNip05("nobody@mailstr.app")).toEqual({ status: "not-found" });
  });

  it("returns not-found on 404", async () => {
    mockFetch(() => new Response("", { status: 404 }));
    expect(await lookupNip05("nobody@mailstr.app")).toEqual({ status: "not-found" });
  });

  // Must NOT collapse into not-found: a 500 is retryable (451), an absent
  // name is permanent (550). See §6A step 2.
  it("returns error on a 500", async () => {
    mockFetch(() => new Response("", { status: 500 }));
    expect((await lookupNip05("alice@mailstr.app")).status).toBe("error");
  });

  it("returns error when the network throws", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    expect((await lookupNip05("alice@mailstr.app")).status).toBe("error");
  });

  it("returns error for an address with no @", async () => {
    expect((await lookupNip05("alice")).status).toBe("error");
  });
});
