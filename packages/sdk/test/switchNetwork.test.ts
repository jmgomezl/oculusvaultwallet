import { test } from "node:test";
import assert from "node:assert/strict";
import { OculusVault } from "../src/wallet.js";
import { LocalEncryptedKeyProvider } from "../src/keyprovider/LocalEncryptedKeyProvider.js";
import { MemoryStorage } from "../src/storage/Storage.js";

const FAST_KDF = {
  algorithm: "argon2id" as const,
  iterations: 1,
  memorySize: 8192,
  parallelism: 1,
  hashLength: 32,
};

/** Mirror stub: pretend the account exists on testnet but not on mainnet. */
function fetchStub(url: RequestInfo | URL): Promise<Response> {
  const u = String(url);
  if (u.includes("/api/v1/accounts/")) {
    if (u.startsWith("https://testnet.")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ account: "0.0.111", balance: { balance: 500 } }),
          { status: 200 },
        ),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

test("switchNetwork keeps the key/address, resets the account id", async () => {
  const wallet = new OculusVault({
    network: "testnet",
    keyProvider: new LocalEncryptedKeyProvider(new MemoryStorage()),
    fetchImpl: fetchStub as typeof fetch,
  });
  const id = await wallet.createOrRecoverWallet({
    userId: "42",
    secret: { source: "password", value: "hunter2hunter2" },
    // fast KDF via provision defaults is not exposed here; acceptable: 64MiB once
  });

  assert.equal(wallet.network, "testnet");
  assert.equal(id.hederaAccountId, "0.0.111"); // resolved on testnet

  wallet.switchNetwork("mainnet");
  assert.equal(wallet.network, "mainnet");
  // Same address — no re-unlock required.
  assert.equal(wallet.getIdentity().evmAddress, id.evmAddress);
  // Account id reset; mainnet resolves to "not created yet".
  assert.equal(wallet.getIdentity().hederaAccountId, null);
  assert.equal(await wallet.refreshAccountId(), null);

  // Switching back re-resolves the testnet account.
  wallet.switchNetwork("testnet");
  assert.equal(await wallet.refreshAccountId(), "0.0.111");

  // Exporting still works after switches (key never dropped).
  assert.match(await wallet.exportKey(), /^[0-9a-f]{64}$/);

  // Password-gated export: correct password re-decrypts to the same key…
  const inMemory = await wallet.exportKey();
  const reVerified = await wallet.exportKeyWithSecret({
    source: "password",
    value: "hunter2hunter2",
  });
  assert.equal(reVerified, inMemory);

  // …a wrong password is rejected even though the wallet is unlocked.
  await assert.rejects(
    wallet.exportKeyWithSecret({ source: "password", value: "not-the-password" }),
    /decrypt|match|wrong/i,
  );
});
