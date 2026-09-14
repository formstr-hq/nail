import { useMemo } from "react";
import { useAccountStore } from "@/app/store/account";
import { useSettingsStore } from "@/app/store/settings";
import { useOwnedAddresses } from "@/app/hooks/useOwnedAddresses";
import { BRIDGE_DOMAIN } from "@/app/lib/nostr/constants";

/**
 * Every address this account owns: the default npub mailbox, a configured
 * sender address, and any NIP-05 aliases — deduped, case-insensitively,
 * keeping first-seen order (npub mailbox first). Doubles as "everything that
 * is me" for Reply-all and as the per-alias inbox list in the sidebar.
 */
export function useSelfAddresses(): string[] {
  const { account } = useAccountStore();
  const settings = useSettingsStore((s) => s.settings);
  const { addresses } = useOwnedAddresses();

  return useMemo(() => {
    const candidates = [
      account ? `${account.npub}@${BRIDGE_DOMAIN}` : "",
      settings.senderAddress ?? "",
      ...addresses,
    ].filter(Boolean);
    const seen = new Set<string>();
    return candidates.filter((a) => {
      const key = a.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [account, settings.senderAddress, addresses]);
}