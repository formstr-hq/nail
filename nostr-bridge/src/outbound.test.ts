import { describe, it, expect, vi, afterEach } from "vitest";
import {
  authorizeSender,
  selectDeliverTargets,
  selectDeliverTargetsWithManaged,
} from "./outbound.js";

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

  it("accepts a managed tenant domain when the directory knows it", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "alice@acme.com",
      sealPubkey: ALICE,
      localDomains: LOCAL,
      isManagedDomain: async () => true,
    });
    expect(result).toEqual({ ok: true, address: "alice@acme.com" });
  });

  it("rejects an unknown domain even when the directory is consulted", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "alice@random.tld",
      sealPubkey: ALICE,
      localDomains: LOCAL,
      isManagedDomain: async () => false,
    });
    expect(result.ok).toBe(false);
  });

  // An unverifiable domain must not be relayed: a directory outage is not
  // permission to send as somebody else's domain.
  it("fails closed when the directory lookup throws", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "alice@acme.com",
      sealPubkey: ALICE,
      localDomains: LOCAL,
      isManagedDomain: async () => {
        throw new Error("directory down");
      },
    });
    expect(result.ok).toBe(false);
  });

  it("still rejects a tenant address owned by a different key", async () => {
    mockNames({ alice: ALICE });
    const result = await authorizeSender({
      from: "alice@acme.com",
      sealPubkey: MALLORY,
      localDomains: LOCAL,
      isManagedDomain: async () => true,
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

describe("selectDeliverTargetsWithManaged", () => {
  const managed = (domains: string[]) => async (domain: string) =>
    domains.includes(domain.toLowerCase());

  it("treats a managed tenant domain as local — never relay it through SMTP", async () => {
    const result = await selectDeliverTargetsWithManaged(
      ["alice@acme.com", "bob@gmail.com"],
      LOCAL,
      managed(["acme.com"]),
    );
    expect(result).toEqual({
      deliver: ["bob@gmail.com"],
      rejected: ["alice@acme.com"],
    });
  });

  it("leaves an unmanaged domain as a normal relay target", async () => {
    const result = await selectDeliverTargetsWithManaged(
      ["alice@random.tld", "bob@gmail.com"],
      LOCAL,
      managed(["acme.com"]),
    );
    expect(result.deliver).toEqual(["alice@random.tld", "bob@gmail.com"]);
    expect(result.rejected).toEqual([]);
  });

  // Directory outage must not silently drop mail: an unresolvable domain falls
  // back to the ordinary relay path, where downstream decides its fate.
  it("treats a directory failure as not-local rather than dropping the target", async () => {
    const result = await selectDeliverTargetsWithManaged(
      ["alice@acme.com"],
      LOCAL,
      async () => {
        throw new Error("directory down");
      },
    );
    expect(result.deliver).toEqual(["alice@acme.com"]);
    expect(result.rejected).toEqual([]);
  });

  it("checks each distinct domain once", async () => {
    const seen: string[] = [];
    await selectDeliverTargetsWithManaged(
      ["a@acme.com", "b@acme.com", "c@other.tld"],
      LOCAL,
      async (domain) => {
        seen.push(domain);
        return domain === "acme.com";
      },
    );
    // acme.com once despite two recipients; other.tld once.
    expect(seen.sort()).toEqual(["acme.com", "other.tld"]);
  });
});
