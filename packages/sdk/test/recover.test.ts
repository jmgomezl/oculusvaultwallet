import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalEncryptedKeyProvider } from "../src/keyprovider/LocalEncryptedKeyProvider.js";
import { MemoryStorage } from "../src/storage/Storage.js";
import { generateKey } from "../src/crypto/keys.js";

const FAST_KDF = {
  algorithm: "argon2id" as const,
  iterations: 1,
  memorySize: 8192,
  parallelism: 1,
  hashLength: 32,
};

const KEY = "test:wallet:42";
const pw = (value: string) => ({ source: "password" as const, value });

test("forgot-password recovery: import backed-up key with a NEW password", async () => {
  const provider = new LocalEncryptedKeyProvider(new MemoryStorage());

  // Day 1: wallet created with password A; user backs up the key.
  const created = await provider.provision({
    storageKey: KEY,
    secret: pw("password-A-original"),
    kdf: FAST_KDF,
  });
  const backedUpKey = await provider.exportPrivateKey({
    storageKey: KEY,
    secret: pw("password-A-original"),
  });

  // Day 30: password forgotten. Restore from the backup with password B.
  const restored = await provider.importPrivateKey!({
    storageKey: KEY,
    privateKeyHex: backedUpKey,
    secret: pw("password-B-new"),
    kdf: FAST_KDF,
  });
  assert.equal(restored.evmAddress, created.evmAddress); // same wallet

  // New password unlocks…
  const rec = await provider.recover({ storageKey: KEY, secret: pw("password-B-new") });
  assert.equal(rec.evmAddress, created.evmAddress);
  assert.equal(rec.privateKeyHex, backedUpKey);

  // …and the old one no longer does.
  await assert.rejects(
    provider.recover({ storageKey: KEY, secret: pw("password-A-original") }),
    /Failed to decrypt/,
  );
});

test("getStoredAddress exposes the record's public address (no secret)", async () => {
  const provider = new LocalEncryptedKeyProvider(new MemoryStorage());
  assert.equal(await provider.getStoredAddress!(KEY), null);
  const created = await provider.provision({
    storageKey: KEY,
    secret: pw("some-password-1"),
    kdf: FAST_KDF,
  });
  assert.equal(await provider.getStoredAddress!(KEY), created.evmAddress);
});

test("importing a DIFFERENT key replaces the stored wallet (detectable beforehand)", async () => {
  const provider = new LocalEncryptedKeyProvider(new MemoryStorage());
  const original = await provider.provision({
    storageKey: KEY,
    secret: pw("some-password-1"),
    kdf: FAST_KDF,
  });

  const other = generateKey();
  // The UI can detect the mismatch before importing:
  assert.notEqual(
    (await provider.getStoredAddress!(KEY))!.toLowerCase(),
    other.evmAddress.toLowerCase(),
  );

  const imported = await provider.importPrivateKey!({
    storageKey: KEY,
    privateKeyHex: other.privateKeyHex,
    secret: pw("some-password-2"),
    kdf: FAST_KDF,
  });
  assert.equal(imported.evmAddress, other.evmAddress);
  assert.notEqual(imported.evmAddress, original.evmAddress);
  assert.equal(await provider.getStoredAddress!(KEY), other.evmAddress);
});

test("import rejects malformed keys without touching the stored record", async () => {
  const provider = new LocalEncryptedKeyProvider(new MemoryStorage());
  const created = await provider.provision({
    storageKey: KEY,
    secret: pw("some-password-1"),
    kdf: FAST_KDF,
  });
  await assert.rejects(
    provider.importPrivateKey!({
      storageKey: KEY,
      privateKeyHex: "not-a-key",
      secret: pw("whatever-pass"),
      kdf: FAST_KDF,
    }),
  );
  assert.equal(await provider.getStoredAddress!(KEY), created.evmAddress);
});
