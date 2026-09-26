/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_FLAVOR?: string;
  readonly VITE_BRAND_NAME?: string;
  readonly VITE_BRAND_TITLE?: string;
  readonly VITE_BRAND_TAGLINE?: string;
  readonly VITE_DEFAULT_AGENT_ID?: string;
  readonly VITE_HOST_TOOLS?: string;
  readonly VITE_APPROVAL?: string;
  readonly VITE_CHAT_MODES?: string;
  readonly VITE_SETTINGS?: string;
  /** `'true'` 才打开对话与配置的导出/导入。缺省关。 */
  readonly VITE_PORTABLE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
