/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of a running sync server instance, e.g. http://localhost:3000.
   *  Unset or empty: the web app is purely local (no Connect UI, no sync
   *  requests, no default URL). See web/src/account-client.ts. */
  readonly VITE_FUNGIBLE_SYNC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
