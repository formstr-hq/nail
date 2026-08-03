import { describe, it, expect, vi, afterEach } from "vitest";
import { authorizeSender, selectDeliverTargets } from "./outbound.js";

const ALICE = "a".repeat(64);
const MALLORY = "b".repeat(64);
const LOCAL = ["mailstr.app"];

function mockNames(names: Record<string, string>) {
  vi.stubGlobal("fetch", vi.fn(() => new Response(JSON.stringify({ names }))));
}

afterEach(() => vi.unstubAllGlobals());

describe("authorizeSender", () => {
  it("accepts a From the sealer provably owns", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "alice@mailstr.app", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result).toEqual({ ok: true, address: "alice@mailstr.app" });
  });

  // The §5 attack, at the authorization layer.
  it("rejects a From owned by someone else", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "alice@mailstr.app", sealPubkey: MALLORY, localDomains: LOCAL,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a From on a non-local domain", async () => {
    const result = await authorizeSender({
      from: "someone@gmail.com", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("gmail.com");
  });

  it("rejects an unregistered local name", async () => {
    mockNames({});
    const result = await authorizeSender({
      from: "ghost@mailstr.app", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result.ok).toBe(false);
  });

  it("authorizes plus-addressed and mixed-case From against the base name", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "Alice+news@mailstr.app", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed when the lookup errors", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("down"))));
    const result = await authorizeSender({
      from: "alice@mailstr.app", sealPubkey: ALICE, localDomains: LOCAL,
    });
    expect(result.ok).toBe(false);
  });
});

describe("selectDeliverTargets", () => {
  it("keeps external targets", () => {
    expect(selectDeliverTargets(["b@gmail.com", "c@yahoo.com"], LOCAL)).toEqual({
      deliver: ["b@gmail.com", "c@yahoo.com"],
      rejected: [],
    });
  });

  // §6B step 5: local mailboxes are reachable over Nostr. Relaying to them
  // here would bypass the inbound path's rules.
  it("rejects local-domain targets", () => {
    expect(selectDeliverTargets(["b@gmail.com", "eve@mailstr.app"], LOCAL)).toEqual({
      deliver: ["b@gmail.com"],
      rejected: ["eve@mailstr.app"],
    });
  });

  it("deduplicates case-insensitively", () => {
    expect(selectDeliverTargets(["B@Gmail.com", "b@gmail.com"], LOCAL).deliver)
      .toEqual(["B@Gmail.com"]);
  });

  it("drops malformed addresses", () => {
    expect(selectDeliverTargets(["nope", "b@gmail.com"], LOCAL)).toEqual({
      deliver: ["b@gmail.com"],
      rejected: ["nope"],
    });
  });
});
