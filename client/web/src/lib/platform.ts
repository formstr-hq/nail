import { Capacitor } from "@capacitor/core";

/**
 * Runtime platform checks. The merged web app is one build served both on the
 * web and inside the native Capacitor app (Android); a few affordances differ
 * (a browser-extension signer only exists on the web, a NIP-55 signer app only
 * on native).
 */

/** True when running inside the native Capacitor app (its WebView). */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * True in a build made for an app store (Play / App Store). Baked in at build
 * time by `VITE_STORE_BUILD=1`, never inferred at runtime: the direct APK is
 * native too but is not a store build, and store bundles must not contain the
 * Lightning or card code at all (see lib/payments/methods.ts).
 *
 * Code that must be removed from store bundles tests `import.meta.env`
 * directly, so the bundler can drop the branch; this helper is for runtime
 * decisions that only change what is shown.
 */
export function isStoreBuild(): boolean {
  return import.meta.env.VITE_STORE_BUILD === "1";
}
