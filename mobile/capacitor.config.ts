import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.formstr.mail',
  appName: 'Mail by Form*',
  // The combined web bundle: landing at '/', client at '/mails/'. Assembled by
  // scripts/build-web.mjs; `cap sync` copies it into the Android project.
  webDir: 'www',
  android: {
    // Serve the bundle from https://localhost so the landing -> client handoff
    // (a same-origin navigation to /mails/) and the app's calls to
    // api.formstr.app behave exactly like the deployed site.
    initialFocus: false,
  },
  plugins: {
    // Route fetch/XHR through the native HTTP stack. The WebView's origin is
    // https://localhost, and api.formstr.app rejects that CORS origin (returns
    // 500, no ACAO header), so every browser-context API call fails. Native
    // requests carry no browser Origin and aren't subject to CORS, so the same
    // fetch() calls in client/landing just work. WebSocket relay connections
    // are unaffected (not CORS-gated).
    CapacitorHttp: {
      enabled: true,
    },
    StatusBar: {
      // Draw the app behind a transparent status bar (edge-to-edge) and let CSS
      // safe-area insets pad the content. This is the only approach that works
      // on Android 15, where the plugin's non-overlay path (setStatusBarColor)
      // is a no-op, so the layout is identical across OS versions.
      overlaysWebView: true,
      // The suite's canvas is light "paper", so the status bar wants dark icons.
      // (Capacitor's Style.Light == dark content for a light background.)
      style: 'LIGHT',
    },
  },
};

export default config;
