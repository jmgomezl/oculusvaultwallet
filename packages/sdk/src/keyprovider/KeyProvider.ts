import type { UserSecret } from "../crypto/encryption.js";
import type { KdfParams } from "../types.js";

/**
 * Key material handed back to the Wallet after provision/recover.
 *
 * Local providers expose the raw `privateKeyHex` so the Wallet can sign with
 * @hashgraph/sdk. Future remote/MPC providers (e.g. Web3Auth) may instead
 * expose a `signer` and omit the raw key — the Wallet only requires that ONE
 * of them is present.
 */
export interface WalletKeyMaterial {
  evmAddress: string;
  privateKeyHex?: string;
}

export interface ProvisionArgs {
  /** Namespaced storage key for this user (derived from Telegram id, never
   * used as key material). */
  storageKey: string;
  secret: UserSecret;
  kdf?: Omit<KdfParams, "salt">;
}

export interface RecoverArgs {
  storageKey: string;
  secret: UserSecret;
}

export interface ImportArgs {
  storageKey: string;
  /** The raw private key the user backed up (hex, with or without 0x). */
  privateKeyHex: string;
  /** The NEW secret to encrypt it with. */
  secret: UserSecret;
  kdf?: Omit<KdfParams, "salt">;
}

/**
 * Swappable key-management strategy. The shipped default is
 * LocalEncryptedKeyProvider (self-custodial, vendor-free). Alternative
 * implementations (Web3Auth MPC, Lit PKP) can satisfy the same contract.
 */
export interface KeyProvider {
  /** Stable identifier, e.g. "local-encrypted". */
  readonly id: string;
  /** Does a wallet already exist for this storage key? */
  hasWallet(storageKey: string): Promise<boolean>;
  /** Create a brand-new wallet, persist its encrypted record, return identity. */
  provision(args: ProvisionArgs): Promise<WalletKeyMaterial>;
  /** Load and unlock an existing wallet. Throws on wrong secret. */
  recover(args: RecoverArgs): Promise<WalletKeyMaterial>;
  /** Export the raw private key (self-custody proof). Optional for remote
   * providers that cannot reveal a key. */
  exportPrivateKey?(args: RecoverArgs): Promise<string>;
  /**
   * Restore a wallet from a user-supplied private key (forgot-password
   * recovery / import), encrypting it with a NEW secret and REPLACING any
   * stored record. Optional for remote providers.
   */
  importPrivateKey?(args: ImportArgs): Promise<WalletKeyMaterial>;
  /** The stored record's public address without needing the secret — lets a
   * recovery UI warn before replacing a different wallet. */
  getStoredAddress?(storageKey: string): Promise<string | null>;
  /** Delete the stored record for this user. */
  remove(storageKey: string): Promise<void>;
}
