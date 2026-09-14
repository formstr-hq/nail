import { create } from "zustand";

/**
 * Overlay state for the in-app "buy a new address" wizard. Not a route on
 * purpose, for the same reason the composer isn't: the wizard opens *over*
 * the Settings pane or an open composer, and a URL would unmount — and lose —
 * that context (unsaved Settings edits, the draft). A dedicated store keeps
 * everything beneath it mounted; the Android back handler reads this store
 * (see App.tsx handleBack).
 */
interface BuyOverlay {
  visible: boolean;
  open: () => void;
  close: () => void;
}

export const useBuyOverlay = create<BuyOverlay>((set) => ({
  visible: false,
  open: () => set({ visible: true }),
  close: () => set({ visible: false }),
}));