/**
 * secp256k1 key generation and EVM-address derivation.
 *
 * We use @noble/curves (audited) for key material and keccak_256 for the
 * Ethereum-style address so the SDK has no hidden dependency on a wallet
 * library for the core primitive. The same key is later handed to ethers /
 * @hashgraph/sdk for signing.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export interface Secp256k1Key {
  /** 32-byte private key (hex, no 0x). */
  privateKeyHex: string;
  /** 33-byte compressed public key (hex, no 0x). */
  publicKeyHex: string;
  /** Checksummed 0x EVM address. */
  evmAddress: string;
}

/** Strip an optional 0x prefix. */
function strip0x(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

/** EIP-55 checksum a 20-byte lowercase hex address (no 0x). */
function toChecksumAddress(addressLower: string): string {
  const hash = bytesToHex(keccak_256(addressLower));
  let out = "0x";
  for (let i = 0; i < addressLower.length; i++) {
    const c = addressLower[i]!;
    out += parseInt(hash[i]!, 16) >= 8 ? c.toUpperCase() : c;
  }
  return out;
}

/** Derive the checksummed EVM address from a secp256k1 public key (compressed
 * or uncompressed, hex with or without 0x). */
export function evmAddressFromPublicKey(publicKeyHex: string): string {
  const pubBytes = hexToBytes(strip0x(publicKeyHex));
  // Normalise to the 64-byte uncompressed body (drop the 0x04 prefix byte).
  const point = secp256k1.ProjectivePoint.fromHex(pubBytes);
  const uncompressed = point.toRawBytes(false).slice(1); // 64 bytes
  const hash = keccak_256(uncompressed); // 32 bytes
  const addressLower = bytesToHex(hash.slice(-20));
  return toChecksumAddress(addressLower);
}

/** Build the full key view from a 32-byte private key. */
export function fromPrivateKey(privateKeyHex: string): Secp256k1Key {
  const pkHex = strip0x(privateKeyHex);
  const priv = hexToBytes(pkHex);
  if (priv.length !== 32) {
    throw new Error(`Expected 32-byte private key, got ${priv.length} bytes`);
  }
  const pub = secp256k1.getPublicKey(priv, true); // compressed
  const publicKeyHex = bytesToHex(pub);
  return {
    privateKeyHex: pkHex,
    publicKeyHex,
    evmAddress: evmAddressFromPublicKey(publicKeyHex),
  };
}

/** Generate a fresh secp256k1 key. Uses the platform CSPRNG via @noble. */
export function generateKey(): Secp256k1Key {
  const priv = secp256k1.utils.randomPrivateKey();
  return fromPrivateKey(bytesToHex(priv));
}
