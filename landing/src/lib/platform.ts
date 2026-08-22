import { Capacitor } from "@capacitor/core";

/**
 * Runtime platform checks. The landing is one build served both on the web and
 * inside the native Capacitor app (Android at '/'); a few affordances differ
 * (a browser-extension signer only exists on the web, a NIP-55 signer app only
 * on native).
 */

/** True when running inside the native Capacitor app (its WebView). */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}
