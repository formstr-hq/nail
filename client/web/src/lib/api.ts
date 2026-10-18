import { config } from "./config";

/**
 * Pubkey owning a NIP-05 name, or null — null means the name is available.
 * Queries the mail domain's /.well-known/nostr.json directly (NIP-05)
 * instead of the backend, so availability checks cost the API nothing.
 */
export async function resolveNip05(name: string): Promise<string | null> {
  const res = await fetch(
    `https://${config.mailDomain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`,
    // NIP-05 forbids redirects on this endpoint.
    { redirect: "error" },
  );
  if (res.status === 404) return null; // no record → name is free
  if (!res.ok) throw new Error(`NIP-05 lookup failed (${res.status})`);
  const data = (await res.json()) as { names?: Record<string, string> };
  return data.names?.[name] ?? null;
}

/** One purchasable plan within a product. A product exposes a list of these; a
 *  tier that isn't sellable yet has `available: false` (it's a real tier, not a
 *  string teased inside another tier). New tiers are just new entries. */
export interface MailTier {
  id: string;
  name: string;
  description: string;
  billing: string; // cadence label, backend-driven: "one-time" (base) or e.g. "per month" (storage)
  features: string[]; // included on this tier (✓)
  notIncluded: string[]; // explicitly not on this tier (✗), e.g. attachments
  available: boolean; // whether the tier can be purchased
  /** Store SKU ids for this tier, per platform (null when not sold there). */
  store: { apple: string | null; google: string | null };
  /**
   * The backend's price fields, passed through untouched. Only the payment
   * method modules know how to read them, so shared code never has to name a
   * payment rail (store bundles must not).
   */
  pricing: Readonly<Record<string, unknown>>;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? (value as unknown[]).filter((f): f is string => typeof f === "string") : [];

const sku = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** Normalise one backend tier so a partial response can't break the UI. */
export function normalizeTier(raw: unknown): MailTier | null {
  if (!raw || typeof raw !== "object") return null;
  const {
    id,
    name,
    description,
    billing,
    features,
    notIncluded,
    available,
    store,
    ...pricing
  } = raw as Record<string, unknown>;
  if (typeof id !== "string" || !id) return null;
  const skus = (store ?? {}) as Record<string, unknown>;
  return {
    id,
    name: typeof name === "string" ? name : "Mail",
    description: typeof description === "string" ? description : "",
    // Cadence is backend-driven so recurring tiers change copy without a
    // frontend release; default to the base case.
    billing: typeof billing === "string" ? billing : "one-time",
    features: strings(features),
    notIncluded: strings(notIncluded),
    available: available !== false,
    store: { apple: sku(skus.apple), google: sku(skus.google) },
    pricing,
  };
}

/** The mail tiers to show on the signup screen. */
export async function getMailTiers(): Promise<MailTier[]> {
  const res = await fetch(`${config.apiBaseUrl}/api/tiers/mail`);
  if (!res.ok) throw new Error(`Tiers unavailable (${res.status})`);
  const data: unknown = await res.json();
  const tiers = (Array.isArray(data) ? data : []).flatMap((t) => normalizeTier(t) ?? []);
  if (tiers.length === 0) throw new Error("No tiers available");
  return tiers;
}

/** Absolute URL of an API path — NIP-98 signs the exact URL being called. */
export function apiUrl(path: string): string {
  return `${config.apiBaseUrl}${path}`;
}

/** True if the response body names at least one owned NIP-05 address. Tolerant
 *  of the several shapes the backend has returned (bare string, array, or an
 *  object with `nip05`/`nip05Addresses`), matching the client's normalizer. */
function hasAnyAddress(body: unknown): boolean {
  if (typeof body === "string") return body.trim().length > 0;
  if (Array.isArray(body)) {
    return body.some((e) =>
      typeof e === "string"
        ? e.trim().length > 0
        : !!e &&
          typeof e === "object" &&
          (typeof (e as Record<string, unknown>).nip05 === "string" ||
            typeof (e as Record<string, unknown>).name === "string"),
    );
  }
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    if (typeof o.nip05 === "string") return o.nip05.trim().length > 0;
    if (Array.isArray(o.nip05Addresses))
      return o.nip05Addresses.some((v) => typeof v === "string" && v.trim().length > 0);
  }
  return false;
}

/**
 * Whether the signed-in account already owns a mailbox on the mail domain.
 * NIP-98 authenticated (pass a header built with the active signer). Any error
 * or 404 resolves to `false` so a hiccup never blocks a new signup.
 */
export async function ownsMailbox(authHeader: string): Promise<boolean> {
  const res = await fetch(`${config.apiBaseUrl}/api/nip-05/get-nip05`, {
    headers: { Authorization: authHeader },
  });
  if (!res.ok) return false;
  const body = await res.json().catch(() => null);
  return hasAnyAddress(body);
}
