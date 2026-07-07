import { test } from "node:test";
import assert from "node:assert/strict";
import {
  wrapKeyWithSecret,
  unwrapKeyWithSecret,
} from "../src/crypto/quickUnlock.js";
import { generateKey } from "../src/crypto/keys.js";

/** A synthetic PRF secret — 32 bytes, as a real authenticator would return. */
function fakePrfSecret(): { source: "passkey-prf"; value: Uint8Array } {
  const value = new Uint8Array(32);
  for (let i = 0; i < 32; i++) value[i] = (i * 37 + 11) & 0xff;
  return { source: "passkey-prf", value };
}

test("quick-unlock record round-trips with a PRF secret", async () => {
  const key = generateKey();
  const secret = fakePrfSecret();
  const recordJson = await wrapKeyWithSecret({
    privateKeyHex: key.privateKeyHex,
    evmAddress: key.evmAddress,
    secret,
  });

  // Only ciphertext in the record — never the key.
  assert.ok(!recordJson.includes(key.privateKeyHex));
  const parsed = JSON.parse(recordJson);
  assert.equal(parsed.secretSource, "passkey-prf");
  assert.equal(parsed.evmAddress, key.evmAddress);

  const unwrapped = await unwrapKeyWithSecret(recordJson, secret);
  assert.equal(unwrapped.privateKeyHex, key.privateKeyHex);
  assert.equal(unwrapped.evmAddress, key.evmAddress);
});

test("quick-unlock record rejects the wrong PRF secret", async () => {
  const key = generateKey();
  const recordJson = await wrapKeyWithSecret({
    privateKeyHex: key.privateKeyHex,
    evmAddress: key.evmAddress,
    secret: fakePrfSecret(),
  });
  const wrong = fakePrfSecret();
  wrong.value[0]! ^= 0xff;
  await assert.rejects(unwrapKeyWithSecret(recordJson, wrong));
});
