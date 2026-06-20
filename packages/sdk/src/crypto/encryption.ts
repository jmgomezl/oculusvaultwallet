/**
 * Envelope encryption for the wallet private key.
 *
 * Model:  privateKey ──XChaCha20-Poly1305──▶ ciphertext
 *         wrappingKey = Argon2id(userSecret, salt)
 *
 * `userSecret` is either a password the user types or 32 bytes of entropy
 * produced by a WebAuthn passkey PRF. Neither the secret nor the wrapping key
 * ever leaves the device, and only the ciphertext + public params are stored.
 *
 * All primitives are audited: Argon2id via hash-wasm, XChaCha20-Poly1305 via
 * @noble/ciphers. We do NOT hand-roll any cryptography.
 */
import { argon2id } from "hash-wasm";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { hexToBytes, bytesToHex } from "@noble/hashes/utils";
import type { EncryptedWalletRecord, KdfParams, SecretSource } from "../types.js";
import {
  base64urlToBytes,
  bytesToBase64url,
  utf8ToBytes,
} from "./encoding.js";

/** Sensible interactive defaults for Argon2id. Memory cost dominates GPU/ASIC
 * resistance; 64 MiB keeps mobile Telegram webviews responsive. Override for
 * higher-value deployments. */
export const DEFAULT_KDF: Omit<KdfParams, "salt"> = {
  algorithm: "argon2id",
  iterations: 3,
  memorySize: 65536, // KiB == 64 MiB
  parallelism: 1,
  hashLength: 32,
};

export interface UserSecret {
  source: SecretSource;
  /** Password string, or raw passkey-PRF bytes. */
  value: string | Uint8Array;
}

async function deriveWrappingKey(
  secret: UserSecret,
  params: KdfParams,
): Promise<Uint8Array> {
  const password =
    typeof secret.value === "string" ? utf8ToBytes(secret.value) : secret.value;
  const hash = await argon2id({
    password,
    salt: base64urlToBytes(params.salt),
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memorySize,
    hashLength: params.hashLength,
    outputType: "binary",
  });
  return hash;
}

/** Encrypt a 32-byte private key (hex) into a portable record. */
export async function encryptPrivateKey(args: {
  privateKeyHex: string;
  evmAddress: string;
  secret: UserSecret;
  kdf?: Omit<KdfParams, "salt">;
}): Promise<EncryptedWalletRecord> {
  const salt = randomBytes(16);
  const params: KdfParams = {
    ...(args.kdf ?? DEFAULT_KDF),
    salt: bytesToBase64url(salt),
  };
  const wrappingKey = await deriveWrappingKey(args.secret, params);
  const nonce = randomBytes(24); // XChaCha20 nonce
  const cipher = xchacha20poly1305(wrappingKey, nonce);
  const plaintext = hexToBytes(
    args.privateKeyHex.startsWith("0x")
      ? args.privateKeyHex.slice(2)
      : args.privateKeyHex,
  );
  const ciphertext = cipher.encrypt(plaintext);
  // Best-effort wipe of derived key material.
  wrappingKey.fill(0);
  return {
    version: 1,
    evmAddress: args.evmAddress,
    kdf: params,
    nonce: bytesToBase64url(nonce),
    ciphertext: bytesToBase64url(ciphertext),
    secretSource: args.secret.source,
    createdAt: new Date().toISOString(),
  };
}

/** Decrypt a record back to the private key hex. Throws on wrong secret
 * (Poly1305 auth failure). */
export async function decryptPrivateKey(
  record: EncryptedWalletRecord,
  secret: UserSecret,
): Promise<string> {
  const wrappingKey = await deriveWrappingKey(secret, record.kdf);
  const cipher = xchacha20poly1305(
    wrappingKey,
    base64urlToBytes(record.nonce),
  );
  try {
    const plaintext = cipher.decrypt(base64urlToBytes(record.ciphertext));
    return bytesToHex(plaintext);
  } catch (err) {
    throw new Error(
      "Failed to decrypt wallet: wrong password/passkey or corrupted record",
    );
  } finally {
    wrappingKey.fill(0);
  }
}
