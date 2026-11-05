import { describe, it, expect, vi } from "vitest";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";

// config.ts validates these at module load; this test imports through it.
vi.hoisted(() => {
  process.env.LOCAL_DOMAINS = "mailstr.app";
  process.env.NOSTR_BRIDGE_NSEC = "11".repeat(32);
  process.env.BLOSSOM_SERVER_URL = "https://env.example";
  process.env.BRIDGE_RELAYS = "";
});

vi.mock("./drive-share.js", () => ({ uploadDriveShare: vi.fn() }));
import {
  blossomCandidates,
  blossomServersFromEvents,
  offloadAttachments,
} from "./blossom-offload.js";
import { uploadDriveShare, type DriveShareAttachment } from "./drive-share.js";

const mockedShare = vi.mocked(uploadDriveShare);

const shared: DriveShareAttachment = {
  filename: "a.pdf",
  mimeType: "application/pdf",
  size: 90_000,
  shareUrl: "https://drive.formstr.app/#shared=naddr1example&k=" + "a".repeat(64),
  server: "https://env.example",
};

async function attachmentMessage(count = 1, bytes = 90_000): Promise<Buffer> {
  const composer = new MailComposer({
    from: "a@example.com",
    to: "b@example.com",
    subject: "attachment",
    text: "body",
    attachments: Array.from({ length: count }, (_, i) => ({
      filename: `a${i}.pdf`,
      content: Buffer.alloc(bytes, 1),
    })),
  });
  return composer.compile().build();
}

describe("blossomCandidates", () => {
  const env = "https://nos.example";

  it("uses the operator server when the user has none", () => {
    expect(blossomCandidates([], env)).toEqual([env]);
  });

  it("tries the user's servers first, then the operator server", () => {
    expect(blossomCandidates(["https://one.example/", "https://two.example"], env)).toEqual([
      "https://one.example",
      "https://two.example",
      env,
    ]);
  });

  it("de-duplicates and drops invalid URLs", () => {
    expect(
      blossomCandidates(["https://nos.example", "wss://not-http", "https://nos.example"], env),
    ).toEqual([env]);
  });
});

describe("blossomServersFromEvents", () => {
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const sign = (createdAt: number, servers: string[]) =>
    finalizeEvent(
      {
        kind: 10063,
        created_at: createdAt,
        tags: servers.map((server) => ["server", server]),
        content: "",
      },
      sk,
    );

  it("uses the newest signed list", () => {
    const older = sign(100, ["https://old.example"]);
    const newer = sign(200, ["https://new.example"]);
    expect(blossomServersFromEvents([older, newer], pubkey)).toEqual([
      "https://new.example",
    ]);
  });

  it("ignores a tampered newer list and falls back to the valid one", () => {
    const older = sign(100, ["https://old.example"]);
    const tampered = {
      ...sign(200, ["https://old.example"]),
      tags: [["server", "https://evil.example"]],
    };
    expect(blossomServersFromEvents([tampered, older], pubkey)).toEqual([
      "https://old.example",
    ]);
  });

  it("ignores a list signed by another key", () => {
    const other = finalizeEvent(
      {
        kind: 10063,
        created_at: 300,
        tags: [["server", "https://evil.example"]],
        content: "",
      },
      generateSecretKey(),
    );
    expect(blossomServersFromEvents([other], pubkey)).toEqual([]);
  });
});

describe("offloadAttachments", () => {
  it("does not touch a message that already fits one wrap", async () => {
    expect(
      await offloadAttachments(Buffer.from("small"), {
        recipientPubkey: "a".repeat(64),
        relays: [],
        recipient: "b@example.com",
      }),
    ).toBeNull();
  });

  it("uploads through the drive path and writes an attachments.txt link", async () => {
    mockedShare.mockReset();
    mockedShare.mockResolvedValue(shared);

    const raw = await attachmentMessage();
    const result = await offloadAttachments(raw, {
      recipientPubkey: "a".repeat(64),
      relays: [],
      recipient: "b@example.com",
      userServers: ["https://user.example"],
    });

    expect(mockedShare).toHaveBeenCalledWith(
      expect.anything(),
      { filename: "a0.pdf", mimeType: "application/pdf" },
      {
        servers: ["https://user.example", "https://env.example"],
        relays: [],
        deadline: expect.any(Number),
      },
    );
    expect(result).not.toBeNull();
    expect(result!.links).toEqual([{ filename: "a.pdf", url: shared.shareUrl }]);

    const parsed = await simpleParser(Buffer.from(result!.raw, "latin1"));
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].filename).toBe("attachments.txt");
    expect(parsed.attachments[0].content.toString()).toContain(shared.shareUrl);
  });

  it("returns null when the drive upload fails, so the strip fallback runs", async () => {
    mockedShare.mockReset();
    mockedShare.mockResolvedValue(null);

    expect(
      await offloadAttachments(await attachmentMessage(), {
        recipientPubkey: "a".repeat(64),
        relays: [],
        recipient: "b@example.com",
        userServers: ["https://user.example"],
      }),
    ).toBeNull();
  });

  it("is all-or-nothing when one of several attachments fails", async () => {
    let call = 0;
    mockedShare.mockReset();
    mockedShare.mockImplementation(async () => (++call === 1 ? shared : null));

    expect(
      await offloadAttachments(await attachmentMessage(2, 50_000), {
        recipientPubkey: "a".repeat(64),
        relays: [],
        recipient: "b@example.com",
        userServers: ["https://user.example"],
      }),
    ).toBeNull();
    expect(mockedShare).toHaveBeenCalledTimes(2);
  });

  it("returns null for an over-ceiling message with no attachments", async () => {
    const raw = Buffer.from(`Subject: big\r\n\r\n${"x".repeat(100_000)}`, "latin1");
    expect(
      await offloadAttachments(raw, {
        recipientPubkey: "a".repeat(64),
        relays: [],
        recipient: "b@example.com",
      }),
    ).toBeNull();
  });

  it("passes one upload deadline to every attachment", async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    mockedShare.mockReset();
    mockedShare.mockImplementation(async () => {
      now += 200_000;
      return shared;
    });

    try {
      const result = await offloadAttachments(await attachmentMessage(2, 50_000), {
        recipientPubkey: "a".repeat(64),
        relays: [],
        recipient: "b@example.com",
        userServers: ["https://user.example"],
      });

      expect(result).not.toBeNull();
      expect(mockedShare).toHaveBeenCalledTimes(2);
      const first = mockedShare.mock.calls[0]![2];
      const second = mockedShare.mock.calls[1]![2];
      // 240s total, not a fresh budget per attachment.
      expect(second.deadline).toBe(first.deadline);
      expect(first.deadline).toBe(1_000_000 + 240_000);
    } finally {
      clock.mockRestore();
    }
  });
});
