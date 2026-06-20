import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptPrivateKey,
  decryptPrivateKey,
} from "../src/crypto/encryption.js";
import { generateKey } from "../src/crypto/keys.js";

// Faster KDF params so the offline test suite stays quick.
const FAST_KDF = {
  algorithm: "argon2id" as const,
  iterations: 1,
  memorySize: 8192,
  parallelism: 1,
  hashLength: 32,
};

test("encrypt/decrypt roundtrip recovers the private key", async () => {
  const key = generateKey();
  const record = await encryptPrivateKey({
    privateKeyHex: key.privateKeyHex,
    evmAddress: key.evmAddress,
    secret: { source: "password", value: "correct horse battery staple" },
    kdf: FAST_KDF,
  });
  // The stored record must not contain the plaintext key.
  assert.ok(!JSON.stringify(record).includes(key.privateKeyHex));

  const recovered = await decryptPrivateKey(record, {
    source: "password",
    value: "correct horse battery staple",
  });
  assert.equal(recovered, key.privateKeyHex);
});

test("wrong password fails authentication (Poly1305)", async () => {
  const key = generateKey();
  const record = await encryptPrivateKey({
    privateKeyHex: key.privateKeyHex,
    evmAddress: key.evmAddress,
    secret: { source: "password", value: "right-secret" },
    kdf: FAST_KDF,
  });
  await assert.rejects(
    decryptPrivateKey(record, { source: "password", value: "wrong-secret" }),
    /Failed to decrypt/,
  );
});

test("supports raw-bytes (passkey PRF) secrets", async () => {
  const key = generateKey();
  const prf = new Uint8Array(32).fill(7);
  const record = await encryptPrivateKey({
    privateKeyHex: key.privateKeyHex,
    evmAddress: key.evmAddress,
    secret: { source: "passkey-prf", value: prf },
    kdf: FAST_KDF,
  });
  const recovered = await decryptPrivateKey(record, {
    source: "passkey-prf",
    value: new Uint8Array(32).fill(7),
  });
  assert.equal(recovered, key.privateKeyHex);
});
