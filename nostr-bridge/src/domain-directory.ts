import { LRUCache } from "lru-cache";
import type { DomainDirectory } from "./socketmap.js";

/**
 * Tenant-domain directory backed by the formstr backend.
 *
 * Postfix asks the socketmap responder about arbitrary domains on every
 * message, so this keeps a local view: platform domains are always managed
 * (the deployment's own config), tenant domains come from the backend and are
 * cached. A miss triggers a refresh so a newly-activated workspace is picked
 * up without a restart.
 *
 * Availability policy: a refresh failure never empties the last-known-good
 * set. `isManagedDomain` therefore answers from cache even when the backend is
 * down, and only throws when it has never loaded — in which case the socketmap
 * answers TEMP and Postfix defers. Deferring mail is recoverable; bouncing it
 * is not.
 */

export interface DirectoryConfig {
  /** Domains this deployment serves by config (never come from the backend). */
  platformDomains: string[];
  /** Backend base URL, e.g. https://api.formstr.app */
  directoryUrl: string;
  /** Optional bearer key for the directory endpoint. */
  directoryKey?: string;
  /** How long a positive tenant result is trusted. */
  ttlMs: number;
  /** Negative cache: an unmanaged domain is re-checked after this. */
  negativeTtlMs: number;
  /** How long the whole set may go unrefreshed before reads force one. */
  maxStaleMs: number;
}

export class BackendDomainDirectory implements DomainDirectory {
  private readonly platform: Set<string>;
  private readonly positive: LRUCache<string, boolean>;
  private readonly negative: LRUCache<string, boolean>;
  private lastLoadedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly cfg: DirectoryConfig) {
    this.platform = new Set(cfg.platformDomains.map((d) => d.toLowerCase()));
    this.positive = new LRUCache({ max: 10_000, ttl: cfg.ttlMs });
    this.negative = new LRUCache({ max: 10_000, ttl: cfg.negativeTtlMs });
  }

  async isManagedDomain(domain: string): Promise<boolean> {
    const key = domain.toLowerCase();
    if (this.platform.has(key)) return true;

    const cachedPositive = this.positive.get(key);
    if (cachedPositive !== undefined) return cachedPositive;
    if (this.negative.get(key) !== undefined) return false;

    // Unknown domain: refresh once. Concurrent callers share the same fetch.
    if (Date.now() - this.lastLoadedAt > this.cfg.maxStaleMs || this.positive.size === 0) {
      await this.refresh().catch(() => {}); // keep last-known-good on failure
      if (this.platform.has(key) || this.positive.get(key)) return true;
      return false;
    }

    // Fresh data does not contain it: negative-cache so the next message does
    // not re-fetch.
    this.negative.set(key, true);
    return false;
  }

  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchDomains()
      .then((domains) => {
        this.positive.clear();
        this.negative.clear();
        for (const d of domains) this.positive.set(d.toLowerCase(), true);
        this.lastLoadedAt = Date.now();
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async fetchDomains(): Promise<string[]> {
    if (!this.cfg.directoryUrl) {
      throw new Error("directory URL is not configured");
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.cfg.directoryKey) headers.authorization = `Bearer ${this.cfg.directoryKey}`;

    const res = await fetch(this.cfg.directoryUrl, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`directory HTTP ${res.status}`);
    const body = (await res.json()) as { domains?: string[] };
    if (!Array.isArray(body.domains)) throw new Error("directory response missing domains[]");
    return body.domains;
  }
}
