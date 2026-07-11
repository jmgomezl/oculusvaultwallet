import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hashgraph/sdk";
import { toEcdsaDerKey } from "../src/hedera/signerKey.js";
import { generateKey } from "../src/crypto/keys.js";

/**
 * Reproduce EXACTLY how @hashgraph/sdk's `Wallet` constructor (used by the
 * WalletConnect `getHederaWallet` signer) turns a key string into a key:
 *   isDerKey(k) ? PrivateKey.fromStringDer(k) : PrivateKey.fromString(k)
 * `fromString()` defaults to ED25519 for raw hex — that's the whole bug.
 */
const walletCtorParse = (k: string) =>
  (PrivateKey as unknown as { isDerKey(s: string): boolean }).isDerKey(k)
    ? PrivateKey.fromStringDer(k)
    : PrivateKey.fromString(k);

test("toEcdsaDerKey: the WC signer parses it back as the SAME ECDSA account", () => {
  // A real exported key — this is exactly what OculusVault.exportKey() returns.
  const { privateKeyHex } = generateKey();
  const ecdsaPub = PrivateKey.fromStringECDSA(privateKeyHex).publicKey.toStringRaw();

  const derKey = toEcdsaDerKey(privateKeyHex);

  // The DER string is recognised as DER, so the Wallet ctor keeps the curve…
  assert.equal(
    (PrivateKey as unknown as { isDerKey(s: string): boolean }).isDerKey(derKey),
    true,
    "converted key must be DER so the Wallet ctor preserves secp256k1",
  );
  // …and the public key the signer would present matches the account's key.
  assert.equal(walletCtorParse(derKey).publicKey.toStringRaw(), ecdsaPub);
});

test("regression: a RAW-hex key mis-parses as ED25519 (the INVALID_SIGNATURE bug)", () => {
  const { privateKeyHex } = generateKey();
  const ecdsaPub = PrivateKey.fromStringECDSA(privateKeyHex).publicKey.toStringRaw();

  // Passing raw hex (the old bug) routes to fromString() → ED25519 → a key the
  // account does NOT have. This is precisely what the ledger rejected at
  // precheck. If this ever becomes equal, the footgun is back.
  assert.notEqual(walletCtorParse(privateKeyHex).publicKey.toStringRaw(), ecdsaPub);
});
