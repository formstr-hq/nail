import { config } from "./config";

export interface Mailbox {
  id: number;
  pubkey: string;
  expirationDate?: string;
  nip05Addresses: string[];
}

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

/** The user's mailbox, or null if they haven't signed up yet. */
export function getMailbox(pubkey: string): Promise<Mailbox | null> {
  return getJson<Mailbox>(`/api/mails/mailbox/${pubkey}`);
}

/** Pubkey owning a NIP-05 name, or null — null means the name is available. */
export async function resolveNip05(nip05: string): Promise<string | null> {
  const record = await getJson<{ pubkey: string }>(
    `/api/nip-05/get-pubkey/${encodeURIComponent(nip05)}`,
  );
  return record?.pubkey ?? null;
}

/** Current signup price in sats. */
export async function getMailPrice(): Promise<number> {
  const res = await getJson<{ amount: number }>("/api/price/mail");
  if (!res) throw new Error("Price unavailable");
  return res.amount;
}

/**
 * Ask the backend for a Lightning invoice that, once paid, provisions the
 * mailbox. Requires a NIP-98 Authorization header (see nip98.ts).
 */
export async function generateMailInvoice(
  authHeader: string,
  body: { pubkey: string; nip05: string },
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

/** WebSocket that fires { status: "paid" } once the invoice settles. */
export function paymentSocket(paymentHash: string): WebSocket {
  return new WebSocket(`${config.wsBaseUrl}/ws?hash=${paymentHash}`);
}
