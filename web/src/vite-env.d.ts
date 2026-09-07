/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_WS_BASE_URL?: string;
  readonly VITE_MAIL_DOMAIN?: string;
  readonly VITE_MAILS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
