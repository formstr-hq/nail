import { create } from "zustand";
import type { Draft } from "@/app/lib/mail/draft";

/**
 * Overlay state for the compose window, which cannot be a route: a minimized
 * composer must survive navigation (e.g. closing Settings while a draft stays
 * open), and a URL would unmount — and lose — the draft. Everything else that
 * behaves like navigation (settings panes, add-account) lives in the router
 * instead; see App.tsx.
 */
interface ComposeOverlay {
  /** `null` means no compose window; a Draft (possibly empty) means one is open. */
  draft: Draft | null;
  minimized: boolean;
  open: (draft: Draft) => void;
  /**
   * "Write" restores an already-open composer (possibly minimized) rather than
   * discarding its draft for a blank one; only start fresh when none is open.
   */
  startBlank: () => void;
  setMinimized: (minimized: boolean) => void;
  close: () => void;
}

const BLANK: Draft = { to: "", subject: "", body: "" };

export const useComposeOverlay = create<ComposeOverlay>((set, get) => ({
  draft: null,
  minimized: false,
  open: (draft) => set({ draft, minimized: false }),
  startBlank: () => {
    if (get().draft) set({ minimized: false });
    else set({ draft: BLANK, minimized: false });
  },
  setMinimized: (minimized) => set({ minimized }),
  close: () => set({ draft: null, minimized: false }),
}));