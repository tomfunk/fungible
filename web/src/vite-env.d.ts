/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of a running sync server instance, e.g. http://localhost:3000.
   *  Defaults to http://localhost:3000 (the sync server's own PORT default) when
   *  unset. See web/src/account-client.ts. */
  readonly VITE_FUNGIBLE_SYNC_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
