import { describe, it, expect, vi, afterEach } from "vitest";

// Same load-order constraint as the other suites: config.ts reads the env at
// import time and derives the wrap ceiling from RELAY_MAX_EVENT_BYTES.
vi.hoisted(() => {
  process.env.LOCAL_DOMAINS = "mailstr.app";
  process.env.NOSTR_BRIDGE_NSEC = "11".repeat(32);
});

import { config, logEffectiveLimits } from "./config.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("size limits", () => {
  it("derives the raw-message ceiling from the relay event cap and wrap inflation", () => {
    // Defaults: 100 KiB event cap / 2.4 inflation = 42666 bytes.
    expect(config.relayMaxEventBytes).toBe(102400);
    expect(config.maxWrappableMessageBytes).toBe(Math.floor(102400 / 2.4));
  });

  it("keeps the inbound buffer cap at or below the strip path's memory budget", () => {
    // The strip path holds the parsed message plus all attachment buffers;
    // measured anon RSS is ~message + 60 MB. With the stock 128 MB container
    // override, an 8 MB cap peaks ~82 MB — safe, but not much room. This test
    // is the tripwire if someone raises the cap without checking memory.
    expect(config.maxMessageBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe("logEffectiveLimits", () => {
  it("logs all three numbers in KiB", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logEffectiveLimits();

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain("max inbound message 8192 KiB");
    expect(line).toContain("relay event cap 100 KiB");
    expect(line).toContain("raw-message ceiling 42 KiB");
    // The consequence is stated, not just the number: a 552 needs to be
    // explicable from the boot log alone.
    expect(line).toContain("without attachments");
  });
});
