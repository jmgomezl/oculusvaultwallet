import { test } from "node:test";
import assert from "node:assert/strict";
import { fromPrivateKey, evmAddressFromPublicKey } from "../src/crypto/keys.js";

// Well-known secp256k1 vector: private key = 1.
const PK_ONE =
  "0000000000000000000000000000000000000000000000000000000000000001";
const ADDR_ONE = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

test("derives the canonical EVM address for private key = 1", () => {
  const key = fromPrivateKey(PK_ONE);
  assert.equal(key.evmAddress, ADDR_ONE);
});

test("accepts 0x-prefixed keys and is deterministic", () => {
  const a = fromPrivateKey("0x" + PK_ONE);
  const b = fromPrivateKey(PK_ONE);
  assert.equal(a.evmAddress, b.evmAddress);
  assert.equal(a.publicKeyHex, b.publicKeyHex);
});

test("evmAddressFromPublicKey matches fromPrivateKey", () => {
  const key = fromPrivateKey(PK_ONE);
  assert.equal(evmAddressFromPublicKey(key.publicKeyHex), key.evmAddress);
});

test("rejects malformed private keys", () => {
  assert.throws(() => fromPrivateKey("abcd"));
});
