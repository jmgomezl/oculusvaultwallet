/**
 * Agent registry — the encrypted list of agent accounts a user manages.
 *
 * The registry holds NO agent private keys (those are shown once at creation
 * and never stored — re-issue > recovery). It's still encrypted: which agents
 * a user runs, their names and account ids are private metadata.
 *
 * Encryption model: the wrapping key is derived from the OWNER's wallet
 * private key via HKDF-SHA256 (domain-separated). The wallet key is
 * high-entropy, so no password KDF is needed, and any session that can unlock
 * the wallet can read the registry — it follows the user across devices
 * through the shared vault without re-prompting for the password. The
 * ciphertext record intentionally mirrors the vault's `{ciphertext, nonce}`
 * shape so the server's encrypted-only validation applies to it too.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { randomBytes } from "@noble/ciphers/webcrypto";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { hexToBytes } from "@noble/hashes/utils";
import {
  base64urlToBytes,
  bytesToBase64url,
  utf8ToBytes,
} from "./crypto/encoding.js";
import type { HederaNetwork } from "./types.js";

/** One managed agent. Private keys are NEVER stored here. */
export interface AgentRecord {
  /** The agent's Hedera account id (0.0.x) — the stable identifier. */
  accountId: string;
  /** Owner-chosen display name, e.g. "shopper". */
  name: string;
  network: HederaNetwork;
  /** The agent public key in the account's 1-of-2 KeyList — needed to
   * unfreeze without re-issuing. Public material, safe to store. */
  agentPublicKeyHex: string;
  /** Owner's belief about the key state (source of truth is the chain —
   * views should reconcile against the mirror's key structure). */
  frozen: boolean;
  /** HCS audit topic (agent writes via submit key, owner administers). */
  auditTopicId?: string;
  /** Set when the account was deleted on-chain; kept for the ledger view. */
  retiredAt?: string;
  createdAt: string;
}

export interface EncryptedAgentRegistry {
  version: 1;
  /** Base64url XChaCha20-Poly1305 nonce. */
  nonce: string;
  /** Base64url ciphertext of the JSON-encoded AgentRecord[]. */
  ciphertext: string;
}

const HKDF_INFO = "oculusvault:agent-registry:v1";

function registryKey(walletPrivateKeyHex: string): Uint8Array {
  const ikm = hexToBytes(
    walletPrivateKeyHex.startsWith("0x")
      ? walletPrivateKeyHex.slice(2)
      : walletPrivateKeyHex,
  );
  return hkdf(sha256, ikm, undefined, utf8ToBytes(HKDF_INFO), 32);
}

export function encryptAgentRegistry(
  records: AgentRecord[],
  walletPrivateKeyHex: string,
): EncryptedAgentRegistry {
  const key = registryKey(walletPrivateKeyHex);
  const nonce = randomBytes(24);
  try {
    const ciphertext = xchacha20poly1305(key, nonce).encrypt(
      utf8ToBytes(JSON.stringify(records)),
    );
    return {
      version: 1,
      nonce: bytesToBase64url(nonce),
      ciphertext: bytesToBase64url(ciphertext),
    };
  } finally {
    key.fill(0);
  }
}

/** Throws on tamper or a foreign wallet key (Poly1305 auth failure). */
export function decryptAgentRegistry(
  record: EncryptedAgentRegistry,
  walletPrivateKeyHex: string,
): AgentRecord[] {
  const key = registryKey(walletPrivateKeyHex);
  try {
    const plaintext = xchacha20poly1305(
      key,
      base64urlToBytes(record.nonce),
    ).decrypt(base64urlToBytes(record.ciphertext));
    return JSON.parse(new TextDecoder().decode(plaintext)) as AgentRecord[];
  } catch (err) {
    throw new Error(
      "Failed to decrypt agent registry: wrong wallet key or corrupted record",
    );
  } finally {
    key.fill(0);
  }
}
