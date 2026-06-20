/**
 * @oculusvault/sdk — public (client + shared) entrypoint.
 *
 * The Node-only Telegram initData verifier lives in the `/server` entrypoint
 * to keep node:crypto out of browser bundles.
 */

// Core wallet API
export { OculusVault } from "./wallet.js";
export type {
  OculusVaultOptions,
  UnlockArgs,
  OnIncomingOptions,
} from "./wallet.js";

// Types
export type {
  HederaNetwork,
  WalletIdentity,
  Balance,
  HistoryItem,
  TransferDirection,
  IncomingTransfer,
  SendResult,
  EncryptedWalletRecord,
  KdfParams,
  SecretSource,
} from "./types.js";

// Key providers
export type {
  KeyProvider,
  WalletKeyMaterial,
  ProvisionArgs,
  RecoverArgs,
} from "./keyprovider/KeyProvider.js";
export { LocalEncryptedKeyProvider } from "./keyprovider/LocalEncryptedKeyProvider.js";

// Storage
export type { Storage } from "./storage/Storage.js";
export { MemoryStorage } from "./storage/Storage.js";
export { TelegramCloudStorage } from "./storage/TelegramCloudStorage.js";

// Crypto (audited primitives + helpers)
export {
  generateKey,
  fromPrivateKey,
  evmAddressFromPublicKey,
  type Secp256k1Key,
} from "./crypto/keys.js";
export {
  encryptPrivateKey,
  decryptPrivateKey,
  DEFAULT_KDF,
  type UserSecret,
} from "./crypto/encryption.js";
export {
  isPasskeyPrfLikelySupported,
  registerPasskeySecret,
  getPasskeySecret,
  type PasskeyOptions,
} from "./crypto/passkey.js";

// Hedera helpers
export {
  getNetworkConfig,
  hashscanTxUrl,
  hashscanAccountUrl,
  type NetworkConfig,
} from "./hedera/networks.js";
export { MirrorClient, tinybarToHbar } from "./hedera/mirror.js";
export { sendHbar, type SendArgs } from "./hedera/transfer.js";

// Telegram client helpers
export {
  getTelegramWebApp,
  getInitData,
  getUnsafeUserId,
  initTelegram,
  isInsideTelegram,
} from "./telegram/webapp.js";
