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
  apiBaseUrl:
    (env.VITE_API_BASE_URL as string | undefined) ??
    (dev ? "http://localhost:5000" : "https://api.formstr.app"),
  wsBaseUrl:
    (env.VITE_WS_BASE_URL as string | undefined) ??
    (dev ? "ws://localhost:5000" : "wss://api.formstr.app"),
  /** Domain of the addresses users claim (name@mailDomain). */
  mailDomain: (env.VITE_MAIL_DOMAIN as string | undefined) ?? "mailstr.app",
  /** Where the actual mail UI lives (proxy-passed by the external nginx). */
  mailsUrl: (env.VITE_MAILS_URL as string | undefined) ?? "/mails",
};
