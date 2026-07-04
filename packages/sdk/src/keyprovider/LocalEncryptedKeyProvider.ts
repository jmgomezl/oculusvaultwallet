/**
 * Default, vendor-free, self-custodial key provider.
 *
 * Flow:
 *   provision → generate secp256k1 key → encrypt with Argon2id(secret) +
 *               XChaCha20-Poly1305 → store ONLY the ciphertext record.
 *   recover   → load record → decrypt with the user secret.
 *
 * The server never participates and never sees the secret or the key, so this
 * is genuinely non-custodial. The trade-off is UX: the user must supply the
 * secret (passkey PRF or password) to unlock.
 */
import {
  decryptPrivateKey,
  encryptPrivateKey,
  type UserSecret,
} from "../crypto/encryption.js";
import { fromPrivateKey, generateKey } from "../crypto/keys.js";
import type { Storage } from "../storage/Storage.js";
import type { EncryptedWalletRecord } from "../types.js";
import type {
  ImportArgs,
  KeyProvider,
  ProvisionArgs,
  RecoverArgs,
  WalletKeyMaterial,
} from "./KeyProvider.js";

export class LocalEncryptedKeyProvider implements KeyProvider {
  readonly id = "local-encrypted";

  constructor(private readonly storage: Storage) {}

  private async load(storageKey: string): Promise<EncryptedWalletRecord | null> {
    const raw = await this.storage.getItem(storageKey);
    if (!raw) return null;
    return JSON.parse(raw) as EncryptedWalletRecord;
  }

  async hasWallet(storageKey: string): Promise<boolean> {
    return (await this.storage.getItem(storageKey)) != null;
  }

  async provision(args: ProvisionArgs): Promise<WalletKeyMaterial> {
    const existing = await this.load(args.storageKey);
    if (existing) {
      throw new Error(
        "A wallet already exists for this user; use recover() instead",
      );
    }
    const key = generateKey();
    const record = await encryptPrivateKey({
      privateKeyHex: key.privateKeyHex,
      evmAddress: key.evmAddress,
      secret: args.secret,
      kdf: args.kdf,
    });
    await this.storage.setItem(args.storageKey, JSON.stringify(record));
    return { evmAddress: key.evmAddress, privateKeyHex: key.privateKeyHex };
  }

  async recover(args: RecoverArgs): Promise<WalletKeyMaterial> {
    const record = await this.requireRecord(args.storageKey);
    const privateKeyHex = await decryptPrivateKey(record, args.secret);
    const key = fromPrivateKey(privateKeyHex);
    if (key.evmAddress.toLowerCase() !== record.evmAddress.toLowerCase()) {
      throw new Error("Decrypted key does not match stored address");
    }
    return { evmAddress: key.evmAddress, privateKeyHex };
  }

  async exportPrivateKey(args: RecoverArgs): Promise<string> {
    const record = await this.requireRecord(args.storageKey);
    return decryptPrivateKey(record, args.secret);
  }

  /**
   * Forgot-password recovery / key import: validate the supplied key,
   * encrypt it with the NEW secret, and REPLACE the stored record. Callers
   * should compare getStoredAddress() first and warn if this would swap in a
   * different wallet.
   */
  async importPrivateKey(args: ImportArgs): Promise<WalletKeyMaterial> {
    const key = fromPrivateKey(args.privateKeyHex); // throws on malformed keys
    const record = await encryptPrivateKey({
      privateKeyHex: key.privateKeyHex,
      evmAddress: key.evmAddress,
      secret: args.secret,
      kdf: args.kdf,
    });
    await this.storage.setItem(args.storageKey, JSON.stringify(record));
    return { evmAddress: key.evmAddress, privateKeyHex: key.privateKeyHex };
  }

  /** Public address of the stored record (no secret needed), or null. */
  async getStoredAddress(storageKey: string): Promise<string | null> {
    return (await this.load(storageKey))?.evmAddress ?? null;
  }

  async remove(storageKey: string): Promise<void> {
    await this.storage.removeItem(storageKey);
  }

  private async requireRecord(
    storageKey: string,
  ): Promise<EncryptedWalletRecord> {
    const record = await this.load(storageKey);
    if (!record) throw new Error("No wallet found for this user");
    return record;
  }
}

export type { UserSecret };
