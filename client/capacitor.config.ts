import type { CapacitorConfig } from '@capacitor/cli';

// Store builds (Play / App Store) sell through the platform's billing; every
// other build (the direct APK, which has no Google services at all) must not
// carry the purchase plugin, and so none of Play Billing. `cap sync` honours
// includePlugins, so which plugins reach the native project is decided here,
// by the same STORE_BUILD flag that picks the web bundle (see
// scripts/build-web.mjs and scripts/check-store-bundle.mjs).
//
// This file is loaded by the Capacitor CLI as CommonJS, so it can't import
// package.json; keep this list equal to package.json's plugin dependencies
// minus the purchase plugin (check-store-bundle.mjs fails the build if a
// non-store sync still carries the purchase plugin).
const STORE_BUILD = ['1', 'true'].includes(process.env.STORE_BUILD ?? '');
const PLUGINS_WITHOUT_PURCHASES = [
  '@capacitor/app',
  '@capacitor/browser',
  '@capacitor/filesystem',
  '@capacitor/share',
  '@capacitor/status-bar',
  'nostr-signer-capacitor-plugin',
];

const config: CapacitorConfig = {
  appId: 'com.formstr.mail',
  appName: 'Mail by Form*',
  webDir: 'www',
  android: {
    initialFocus: false,
  },
  ...(STORE_BUILD ? {} : { includePlugins: PLUGINS_WITHOUT_PURCHASES }),
  plugins: {
    CapacitorHttp: {
      enabled: true,
    },
    StatusBar: {
      overlaysWebView: true,
      style: 'LIGHT',
    },
  },
};

export default config;
