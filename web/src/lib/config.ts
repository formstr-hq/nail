// Build-time configuration. Every value can be overridden through Vite env
// vars (VITE_*), which the Docker deploy service passes in as build args.
interface ViteEnv {
  DEV?: boolean;
  readonly [key: string]: string | boolean | undefined;
}
const env: ViteEnv =
  // `import.meta.env` only exists inside Vite. prerender.js also imports this
  // module under plain Node (type-stripped), where it must be emulated —
  // with DEV forced false so the production defaults apply.
  typeof import.meta.env === "object"
    ? (import.meta.env as ViteEnv)
    : { DEV: false };
const dev = env.DEV === true;

export const config = {
  // Empty in dev on purpose: requests go to a same-origin path and Vite's
  // `/api` proxy forwards them (see vite.config.ts). api.formstr.app only
  // allows a fixed set of origins and answers anything else with a 500 rather
  // than a CORS rejection, so a direct call from localhost cannot work. Point
  // the proxy at a local backend with VITE_API_PROXY_TARGET=http://localhost:5000.
  apiBaseUrl:
    (env.VITE_API_BASE_URL as string | undefined) ?? (dev ? "" : "https://api.formstr.app"),
  // Same for the payment WebSocket: derive the dev origin from the page so it
  // rides Vite's `/ws` proxy instead of skipping it. (prerender.js imports
  // this module under plain Node — `window` is guarded for that.)
  wsBaseUrl:
    (env.VITE_WS_BASE_URL as string | undefined) ??
    (dev
      ? typeof window === "undefined"
        ? "ws://localhost:5173"
        : `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}`
      : "wss://api.formstr.app"),
  /** Domain of the addresses users claim (name@mailDomain). */
  mailDomain: (env.VITE_MAIL_DOMAIN as string | undefined) ?? "mailstr.app",
  /** Where the actual mail UI lives (proxy-passed by the external nginx). */
  mailsUrl: (env.VITE_MAILS_URL as string | undefined) ?? "/mails",
};
