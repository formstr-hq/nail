import { LRUCache } from "lru-cache";
import type { Event } from "nostr-tools";
import { SimplePool } from "nostr-tools/pool";
import { KIND_DM_RELAYS } from "./protocol/constants.js";
import { withHardcodedRelay } from "./config.js";

export class UserResolver {
  private cache: LRUCache<string, { relays: string[] }>;
  private pool = new SimplePool();

  constructor(
    private bootstrapRelays: string[],
    private defaultRelays: string[],
    maxEntries: number,
    ttlMs: number,
  ) {
    this.cache = new LRUCache({ max: maxEntries, ttl: ttlMs });
  }

  /**
   * The recipient's DM relays. NIP-17: "Clients MUST only publish events to
   * the relays listed in the recipient's kind 10050 event." Querying kind
   * 10002 (general write relays) instead put inbound mail on relays the
   * client never subscribes to.
   */
  async getDmRelays(pubkey: string): Promise<string[]> {
    const cached = this.cache.get(pubkey);
    if (cached) return cached.relays;

    const relays = await this.resolveFromNetwork(pubkey);
    this.cache.set(pubkey, { relays });
    return relays;
  }

  private async resolveFromNetwork(pubkey: string): Promise<string[]> {
    let events: Event[] = [];
    try {
      events = await this.pool.querySync(
        this.bootstrapRelays,
        { kinds: [KIND_DM_RELAYS], authors: [pubkey] },
        { maxWait: 4000 },
      );
    } catch {
      events = [];
    }

    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    if (!latest) return withHardcodedRelay(this.defaultRelays);

    const relays = latest.tags
      .filter((t) => t[0] === "relay" && t[1])
      .map((t) => t[1]);
    // Always union in the hardcoded reliability relay (relay.primal.net) so
    // outbound mail also reaches it, even when the recipient's own 10050 names
    // other relays. See withHardcodedRelay for the e2e-override escape hatch.
    return withHardcodedRelay(relays.length > 0 ? relays : this.defaultRelays);
  }
}
