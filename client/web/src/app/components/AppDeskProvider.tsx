import { useThemeStore, resolveTheme } from "@/app/store/theme";
import { AppDeskProvider as BaseAppDeskProvider } from "@formstr/common-ui";
import type { CSSProperties, ReactNode } from "react";
import "@formstr/common-ui/styles.css";

/**
 * Mail host wrapper: maps the Mail app's Graph Paper tokens into the shared
 * drawer and mounts it once for the mail client chunk.
 */
export function AppDeskProvider({ children }: { children: ReactNode }) {
  const preference = useThemeStore((s) => s.preference);

  const deskStyle = {
    "--fs-desk-bg": "var(--color-card)",
    "--fs-desk-ink": "var(--color-foreground)",
    "--fs-desk-muted": "var(--color-muted-foreground)",
    "--fs-desk-line": "var(--color-border)",
    "--fs-desk-line-strong": "var(--color-input)",
    "--fs-desk-hover": "var(--color-accent)",
    "--fs-desk-radius": "var(--radius-lg)",
    "--fs-desk-shadow": "0 18px 50px rgba(0, 0, 0, 0.22)",
  } as CSSProperties;

  return (
    <BaseAppDeskProvider
      currentAppId="mail"
      theme={resolveTheme(preference)}
      style={deskStyle}
    >
      {children}
    </BaseAppDeskProvider>
  );
}
