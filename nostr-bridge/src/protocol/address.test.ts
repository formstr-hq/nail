import { describe, it, expect } from "vitest";
import { normalizeLocalpart, splitAddress, isNpub, isHexPubkey } from "./address.js";

describe("normalizeLocalpart", () => {
  it("lowercases the localpart", () => {
    expect(normalizeLocalpart("Xyz@mailstr.app")).toBe("xyz");
  });

  it("strips plus-addressing", () => {
    expect(normalizeLocalpart("xyz+newsletter@mailstr.app")).toBe("xyz");
  });

  it("lowercases and strips together", () => {
    expect(normalizeLocalpart("Xyz+News@mailstr.app")).toBe("xyz");
  });

  it("returns the whole string when there is no @", () => {
    expect(normalizeLocalpart("xyz")).toBe("xyz");
  });
});

describe("splitAddress", () => {
  it("splits and lowercases the domain", () => {
    expect(splitAddress("Alice@Mailstr.App")).toEqual({
      localpart: "alice",
      domain: "mailstr.app",
    });
  });

  it("returns null with no @", () => {
    expect(splitAddress("alice")).toBeNull();
  });

  it("returns null with an empty localpart", () => {
    expect(splitAddress("@mailstr.app")).toBeNull();
  });
});

describe("isNpub / isHexPubkey", () => {
  it("accepts a 63-char npub", () => {
    expect(isNpub("npub1" + "q".repeat(58))).toBe(true);
  });

  it("rejects a short npub", () => {
    expect(isNpub("npub1abc")).toBe(false);
  });

  it("accepts 64 lowercase hex chars", () => {
    expect(isHexPubkey("a".repeat(64))).toBe(true);
  });

  it("rejects uppercase hex", () => {
    expect(isHexPubkey("A".repeat(64))).toBe(false);
  });
});
