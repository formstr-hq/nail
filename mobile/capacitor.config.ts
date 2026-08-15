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
