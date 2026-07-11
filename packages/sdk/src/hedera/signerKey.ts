/**
 * Turn a raw-hex secp256k1 private key (what `OculusVault.exportKey()` returns)
 * into a DER-encoded string that is SAFE to hand to any Hedera signer built by
 * @hashgraph/sdk — in particular the WalletConnect (HIP-820) `Wallet`.
 *
 * The footgun this guards against:
 *   @hashgraph/sdk's `Wallet` constructor runs `PrivateKey.fromString(key)` on
 *   a plain string, and `fromString()` DEFAULTS TO ED25519 for raw hex. Every
 *   OculusVault account is ECDSA (secp256k1 — one key = EVM address + Hedera
 *   alias), so a raw-hex key gets parsed under the WRONG curve, the wallet
 *   signs with a key the account doesn't have, and the ledger rejects every
 *   transaction at precheck with INVALID_SIGNATURE (it never reaches
 *   consensus, so it doesn't even show on the mirror node).
 *
 * A DER string encodes the curve, so the `Wallet` ctor's `isDerKey()` branch
 * routes it to `fromStringDer()` and the ECDSA key is preserved.
 */
import { PrivateKey } from "@hashgraph/sdk";

/** Raw-hex secp256k1 private key → DER-encoded ECDSA key string. */
export function toEcdsaDerKey(privateKeyHex: string): string {
  return PrivateKey.fromStringECDSA(privateKeyHex).toStringDer();
}
