/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_FLAVOR?: string;
  readonly VITE_BRAND_NAME?: string;
  readonly VITE_BRAND_TITLE?: string;
  readonly VITE_BRAND_TAGLINE?: string;
  readonly VITE_DEFAULT_AGENT_ID?: string;
  readonly VITE_HOST_TOOLS?: string;
  readonly VITE_APPROVAL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
