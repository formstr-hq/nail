import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@nostr-bridge/config.js", () => ({
  config: {
    allowedDomains: [] as string[],
    bridgeDomain: "mailstr.app",
  },
}));

vi.mock("@nostr-bridge/nip05.js", () => ({
  lookupNip05Pubkey: vi.fn(),
}));

vi.mock("@nostr-bridge/smtp-injector.js", () => ({
  createPostfixTransport: vi.fn(),
  injectIntoPostfix: vi.fn(),
}));

import { sendMail } from "@nostr-bridge/nostr-listener.js";
import { lookupNip05Pubkey } from "@nostr-bridge/nip05.js";
import { injectIntoPostfix } from "@nostr-bridge/smtp-injector.js";
import { config } from "@nostr-bridge/config.js";
import type { createPostfixTransport } from "@nostr-bridge/smtp-injector.js";

const SENDER_PUBKEY = "a".repeat(64);
const OTHER_PUBKEY = "b".repeat(64);
// The transport is passed straight through to the mocked injectIntoPostfix, so value doesn't matter.
const MOCK_TRANSPORT = null as unknown as ReturnType<typeof createPostfixTransport>;

function rfc2822(from: string, to: string, body = "Hello"): string {
  return `From: ${from}\r\nTo: ${to}\r\nSubject: Test\r\n\r\n${body}`;
}

describe("sendMail — NIP-05 sender verification", () => {
  let notifyError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.mocked(lookupNip05Pubkey).mockReset();
    vi.mocked(injectIntoPostfix).mockReset().mockResolvedValue(undefined);
    notifyError = vi.fn().mockResolvedValue(undefined);
    config.allowedDomains = [];
  });

  describe("ALLOWED_DOMAINS not configured", () => {
    it("delivers without NIP-05 verification", async () => {
      await sendMail(
        rfc2822("alice@anydomain.com", "bob@mailstr.app"),
        [],
        MOCK_TRANSPORT,
        SENDER_PUBKEY,
        notifyError,
      );

      expect(lookupNip05Pubkey).not.toHaveBeenCalled();
      expect(injectIntoPostfix).toHaveBeenCalledOnce();
      expect(notifyError).not.toHaveBeenCalled();
    });
  });

  describe("ALLOWED_DOMAINS configured", () => {
    beforeEach(() => {
      config.allowedDomains = ["mailstr.app"];
    });

    it("rejects mail from a domain not in the allowed list", async () => {
      await sendMail(
        rfc2822("alice@otherdomain.com", "bob@mailstr.app"),
        [],
        MOCK_TRANSPORT,
        SENDER_PUBKEY,
        notifyError,
      );

      expect(lookupNip05Pubkey).not.toHaveBeenCalled();
      expect(injectIntoPostfix).not.toHaveBeenCalled();
      expect(notifyError).toHaveBeenCalledOnce();
      expect(notifyError).toHaveBeenCalledWith(
        SENDER_PUBKEY,
        "alice@otherdomain.com",
        expect.stringContaining("otherdomain.com"),
      );
    });

    it("rejects when the NIP-05 lookup returns null", async () => {
      vi.mocked(lookupNip05Pubkey).mockResolvedValue(null);

      await sendMail(
        rfc2822("alice@mailstr.app", "bob@mailstr.app"),
        [],
        MOCK_TRANSPORT,
        SENDER_PUBKEY,
        notifyError,
      );

      expect(lookupNip05Pubkey).toHaveBeenCalledWith("alice@mailstr.app");
      expect(injectIntoPostfix).not.toHaveBeenCalled();
      expect(notifyError).toHaveBeenCalledOnce();
      expect(notifyError).toHaveBeenCalledWith(
        SENDER_PUBKEY,
        "alice@mailstr.app",
        expect.stringContaining("NIP-05"),
      );
    });

    it("rejects when NIP-05 resolves to a different pubkey", async () => {
      vi.mocked(lookupNip05Pubkey).mockResolvedValue(OTHER_PUBKEY);

      await sendMail(
        rfc2822("alice@mailstr.app", "bob@mailstr.app"),
        [],
        MOCK_TRANSPORT,
        SENDER_PUBKEY,
        notifyError,
      );

      expect(lookupNip05Pubkey).toHaveBeenCalledWith("alice@mailstr.app");
      expect(injectIntoPostfix).not.toHaveBeenCalled();
      expect(notifyError).toHaveBeenCalledOnce();
      expect(notifyError).toHaveBeenCalledWith(
        SENDER_PUBKEY,
        "alice@mailstr.app",
        expect.stringContaining("mismatch"),
      );
    });

    it("delivers mail when NIP-05 resolves to the sender pubkey", async () => {
      vi.mocked(lookupNip05Pubkey).mockResolvedValue(SENDER_PUBKEY);

      await sendMail(
        rfc2822("alice@mailstr.app", "bob@mailstr.app"),
        [],
        MOCK_TRANSPORT,
        SENDER_PUBKEY,
        notifyError,
      );

      expect(lookupNip05Pubkey).toHaveBeenCalledWith("alice@mailstr.app");
      expect(injectIntoPostfix).toHaveBeenCalledOnce();
      expect(notifyError).not.toHaveBeenCalled();
    });

    it("accepts any allowed domain when multiple are configured", async () => {
      config.allowedDomains = ["mailstr.app", "example.com"];
      vi.mocked(lookupNip05Pubkey).mockResolvedValue(SENDER_PUBKEY);

      await sendMail(
        rfc2822("bob@example.com", "alice@mailstr.app"),
        [],
        MOCK_TRANSPORT,
        SENDER_PUBKEY,
        notifyError,
      );

      expect(lookupNip05Pubkey).toHaveBeenCalledWith("bob@example.com");
      expect(injectIntoPostfix).toHaveBeenCalledOnce();
      expect(notifyError).not.toHaveBeenCalled();
    });

    it("drops silently when the To header is missing (no notifyError)", async () => {
      const noToHeader = `From: alice@mailstr.app\r\nSubject: Test\r\n\r\nHello`;

      await sendMail(noToHeader, [], MOCK_TRANSPORT, SENDER_PUBKEY, notifyError);

      expect(injectIntoPostfix).not.toHaveBeenCalled();
      expect(notifyError).not.toHaveBeenCalled();
    });
  });
});
