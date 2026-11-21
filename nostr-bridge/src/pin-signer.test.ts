import { describe, expect, it } from "vitest";
import type { Event, UnsignedEvent } from "nostr-tools";
import type { FileSigner } from "@formstr/drive-sdk";
import { pinUploadSigner } from "./pin-signer.js";

function signer(captured: UnsignedEvent[]): FileSigner {
  return {
    getPublicKey: async () => "f".repeat(64),
    signEvent: async (template: UnsignedEvent) => {
      captured.push(template);
      return { ...template, id: "id", sig: "sig" } as Event;
    },
  };
}

describe("pinUploadSigner", () => {
  it("adds a p tag only to upload authorizations", async () => {
    const captured: UnsignedEvent[] = [];
    const pinTo = "a".repeat(64);
    const wrapped = pinUploadSigner(signer(captured), pinTo);

    await wrapped.signEvent({
      kind: 24242,
      created_at: 1,
      tags: [["t", "upload"], ["x", "b".repeat(64)]],
      content: "",
    });
    await wrapped.signEvent({
      kind: 24242,
      created_at: 1,
      tags: [["t", "delete"], ["x", "b".repeat(64)]],
      content: "",
    });

    expect(captured[0].tags).toContainEqual(["p", pinTo]);
    expect(captured[1].tags).not.toContainEqual(["p", pinTo]);
  });

  it("leaves uploads unchanged when no pin is requested", async () => {
    const captured: UnsignedEvent[] = [];
    const wrapped = pinUploadSigner(signer(captured), undefined);
    await wrapped.signEvent({
      kind: 24242,
      created_at: 1,
      tags: [["t", "upload"], ["x", "b".repeat(64)]],
      content: "",
    });
    expect(captured[0].tags).toEqual([
      ["t", "upload"],
      ["x", "b".repeat(64)],
    ]);
  });
});
