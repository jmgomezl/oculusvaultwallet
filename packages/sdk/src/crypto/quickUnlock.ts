/**
 * Passkey quick-unlock — biometrics WITHOUT changing the custody model.
 *
 * The password-encrypted record in the (shared) vault stays canonical; this
 * module wraps the already-unlocked private key with a passkey-PRF secret and
 * the app stores that wrapped copy DEVICE-LOCALLY only. Face ID then unlocks
 * the local copy; the password always still works everywhere (including the
 * Chrome extension, where WebAuthn for the site's rpId isn't available).
 * Losing the passkey loses nothing but convenience.
 */
import {
  decryptPrivateKey,
  encryptPrivateKey,
  type UserSecret,
} from "./encryption.js";
import {
  getPasskeySecret,
  registerPasskeySecret,
  type PasskeyOptions,
} from "./passkey.js";
import type { EncryptedWalletRecord, KdfParams } from "../types.js";

/** A PRF secret is 32 bytes of authenticator-bound entropy — brute-forcing it
 * is hopeless regardless of KDF cost, so a light Argon2id keeps unlock fast. */
const PRF_KDF: Omit<KdfParams, "salt"> = {
  algorithm: "argon2id",
  iterations: 1,
  memorySize: 8192,
  parallelism: 1,
  hashLength: 32,
};

/** Wrap an unlocked key with any secret (testable core — no WebAuthn). */
export async function wrapKeyWithSecret(args: {
  privateKeyHex: string;
  evmAddress: string;
  secret: UserSecret;
}): Promise<string> {
  const record = await encryptPrivateKey({
    privateKeyHex: args.privateKeyHex,
    evmAddress: args.evmAddress,
    secret: args.secret,
    kdf: PRF_KDF,
  });
  return JSON.stringify(record);
}

/** Unwrap a quick-unlock record with its secret (testable core). */
export async function unwrapKeyWithSecret(
  recordJson: string,
  secret: UserSecret,
): Promise<{ privateKeyHex: string; evmAddress: string }> {
  const record = JSON.parse(recordJson) as EncryptedWalletRecord;
  const privateKeyHex = await decryptPrivateKey(record, secret);
  return { privateKeyHex, evmAddress: record.evmAddress };
}

/**
 * Register a new passkey and wrap the key with its PRF secret. Returns the
 * record JSON for the app to store device-locally, or null when the device
 * can't do passkey PRF (caller keeps password-only unlock).
 */
export async function createPasskeyQuickUnlock(args: {
  privateKeyHex: string;
  evmAddress: string;
  passkey: PasskeyOptions;
}): Promise<string | null> {
  const secret = await registerPasskeySecret(args.passkey);
  if (!secret) return null;
  return wrapKeyWithSecret({
    privateKeyHex: args.privateKeyHex,
    evmAddress: args.evmAddress,
    secret,
  });
}

/**
 * Authenticate with the passkey and unwrap the device-local record. Returns
 * null when the passkey ceremony yields no PRF (caller falls back to
 * password); throws when the record fails to decrypt (stale/corrupt — caller
 * should drop it).
 */
export async function unlockWithPasskeyQuickUnlock(
  recordJson: string,
  opts: Pick<PasskeyOptions, "rpId" | "prfSalt">,
): Promise<{ privateKeyHex: string; evmAddress: string } | null> {
  const secret = await getPasskeySecret(opts);
  if (!secret) return null;
  return unwrapKeyWithSecret(recordJson, secret);
}
