import { useMemo } from "react";
import { useAccountStore } from "@/app/store/account";
import { useOwnedAddresses } from "@/app/hooks/useOwnedAddresses";
import { BRIDGE_DOMAIN } from "@/app/lib/nostr/constants";

/**
 * Every address this account owns: the default npub mailbox and every NIP-05
 * alias (workspace addresses included) — deduped, case-insensitively,
 * keeping first-seen order (npub mailbox first). Doubles as "everything that
 * is me" for Reply-all and as the per-alias inbox list in the sidebar.
 */
export function useSelfAddresses(): string[] {
  const { account } = useAccountStore();
  const { addresses } = useOwnedAddresses();

  return useMemo(() => {
    const candidates = [
      account ? `${account.npub}@${BRIDGE_DOMAIN}` : "",
      ...addresses,
    ].filter(Boolean);
    const seen = new Set<string>();
    return candidates.filter((a) => {
      const key = a.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [account, addresses]);
}