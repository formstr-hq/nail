// Build-time configuration. Every value can be overridden through Vite env
// vars (VITE_*), which the Docker deploy service passes in as build args.
const dev = import.meta.env.DEV;

export const config = {
  apiBaseUrl:
    import.meta.env.VITE_API_BASE_URL ??
    (dev ? "http://localhost:5000" : "https://api.formstr.app"),
  wsBaseUrl:
    import.meta.env.VITE_WS_BASE_URL ??
    (dev ? "ws://localhost:5000" : "wss://api.formstr.app"),
  /** Domain of the addresses users claim (name@mailDomain). */
  mailDomain: import.meta.env.VITE_MAIL_DOMAIN ?? "mailstr.app",
  /** Where the actual mail UI lives (proxy-passed by the external nginx). */
  mailsUrl: import.meta.env.VITE_MAILS_URL ?? "/mails",
};
