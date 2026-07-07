import { LRUCache } from "lru-cache";
import type { Event } from "nostr-tools/pure";
import { SimplePool } from "nostr-tools/pool";

interface UserPreferences {
  writeRelays: string[];
  blossomServerUrl: string;
}

export class UserResolver {
  private cache: LRUCache<string, UserPreferences>;
  private pool = new SimplePool();

  constructor(
    private bootstrapRelays: string[],
    private defaultRelayUrl: string,
    private defaultBlossomServerUrl: string,
    maxEntries: number,
    ttlMs: number,
  ) {
    this.cache = new LRUCache({ max: maxEntries, ttl: ttlMs });
  }

  async getPreferences(pubkey: string): Promise<UserPreferences> {
    const cached = this.cache.get(pubkey);
    if (cached) return cached;

    const prefs = await this.resolveFromNetwork(pubkey);
    this.cache.set(pubkey, prefs);
    return prefs;
  }

  private async resolveFromNetwork(pubkey: string): Promise<UserPreferences> {
    let events: Event[] = [];
    try {
      events = await this.pool.querySync(
        this.bootstrapRelays,
        { kinds: [10002, 10063], authors: [pubkey] },
        { maxWait: 4000 },
      );
    } catch {
      events = [];
    }

    const latest = (kind: number) =>
      events
        .filter((e) => e.kind === kind)
        .sort((a, b) => b.created_at - a.created_at)[0];

    const relayEvent = latest(10002);
    const writeRelays = relayEvent
      ? relayEvent.tags
          .filter((t) => t[0] === "r" && (t.length === 2 || t[2] === "write"))
          .map((t) => t[1])
      : [];

    const blossomEvent = latest(10063);
    const blossomServerUrl =
      blossomEvent?.tags.find((t) => t[0] === "server" && t[1])?.[1] ??
      this.defaultBlossomServerUrl;

    return {
      writeRelays: writeRelays.length > 0 ? writeRelays : [this.defaultRelayUrl],
      blossomServerUrl,
    };
  }
}
