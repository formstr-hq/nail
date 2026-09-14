import { config } from "./config";

export interface MailInvoice {
  invoice: string;
  paymentHash: string;
  amount: number;
}

async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${config.apiBaseUrl}${path}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return (await res.json()) as T;
}

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

/** Current signup price in sats. */
export async function getMailPrice(): Promise<number> {
  const res = await getJson<{ amount: number }>("/api/price/mail");
  if (!res) throw new Error("Price unavailable");
  return res.amount;
}

/** One purchasable plan within a product. A product exposes a list of these; a
 *  tier that isn't sellable yet has `available: false` (it's a real tier, not a
 *  string teased inside another tier). New tiers are just new entries. */
export interface MailTier {
  id: string;
  name: string;
  description: string;
  priceSats: number;
  unit: string; // price unit label, backend-driven (e.g. "sats"); future providers may differ
  billing: string; // cadence label, backend-driven: "one-time" (base) or e.g. "per month" (storage)
  features: string[]; // included on this tier (✓)
  notIncluded: string[]; // explicitly not on this tier (✗), e.g. attachments
  available: boolean; // whether the tier can be purchased
}

// Built-in copy, used only until the backend's /api/tiers/mail is deployed. The
// price still comes from the backend (/api/price/mail).
function fallbackTiers(priceSats: number): MailTier[] {
  return [
    {
      id: "base",
      name: "Mail",
      description: "Your own encrypted mailbox, delivered over Nostr.",
      priceSats,
      unit: "sats",
      billing: "one-time",
      features: [
        `Your name@${config.mailDomain} address`,
        "Send & receive mail, stored encrypted to your key",
      ],
      notIncluded: ["Attachments", "Extra storage"],
      available: true,
    },
  ];
}

/** Tiers from the backend, or `null` if the endpoint isn't there yet. Each
 *  entry is validated/normalized so a partial response can't break the UI. */
async function fetchMailTiers(): Promise<MailTier[] | null> {
  try {
    const res = await fetch(`${config.apiBaseUrl}/api/tiers/mail`);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!Array.isArray(data)) return null;
    const tiers = data
      .filter(
        (t): t is Record<string, unknown> =>
          !!t && typeof t === "object" && typeof (t as { priceSats?: unknown }).priceSats === "number",
      )
      .map((t) => ({
        id: String(t.id ?? ""),
        name: String(t.name ?? "Mail"),
        description: String(t.description ?? ""),
        priceSats: t.priceSats as number,
        // Unit + cadence are backend-driven so new payment providers / recurring
        // tiers change copy without a frontend release; default to the base case.
        unit: typeof t.unit === "string" ? t.unit : "sats",
        billing: typeof t.billing === "string" ? t.billing : "one-time",
        features: Array.isArray(t.features)
          ? (t.features as unknown[]).filter((f): f is string => typeof f === "string")
          : [],
        notIncluded: Array.isArray(t.notIncluded)
          ? (t.notIncluded as unknown[]).filter((f): f is string => typeof f === "string")
          : [],
        available: t.available !== false,
      }));
    return tiers.length ? tiers : null;
  } catch {
    return null;
  }
}

/**
 * The mail tiers to show on the signup screen. Prefers the backend endpoint; if
 * it isn't deployed yet, uses the built-in copy with the live price.
 */
export async function getMailTiers(): Promise<MailTier[]> {
  const fromApi = await fetchMailTiers();
  if (fromApi) return fromApi;
  return fallbackTiers(await getMailPrice());
}

/**
 * Ask the backend for a Lightning invoice that, once paid, provisions the
 * mailbox. Requires a NIP-98 Authorization header (see nip98.ts).
 */
export async function generateMailInvoice(
  authHeader: string,
  body: { pubkey: string; nip05: string; tierId: string },
): Promise<MailInvoice> {
  const res = await fetch(`${config.apiBaseUrl}/api/generate-invoice/mail`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `Invoice request failed (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string };
      if (err.error) message = err.error;
    } catch {
      // keep the status-based message
    }
    throw new Error(message);
  }
  return (await res.json()) as MailInvoice;
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

/** WebSocket that fires { status: "paid" } once the invoice settles. */
export function paymentSocket(paymentHash: string): WebSocket {
  return new WebSocket(`${config.wsBaseUrl}/ws?hash=${paymentHash}`);
}
