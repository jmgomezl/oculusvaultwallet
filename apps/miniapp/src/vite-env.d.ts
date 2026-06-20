/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_HEDERA_NETWORK?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
