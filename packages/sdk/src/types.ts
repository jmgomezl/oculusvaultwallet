/**
 * Shared types for the Hedera Telegram Wallet SDK.
 *
 * Design note: the public surface deliberately speaks in terms of an
 * `evmAddress` (0x...) and a `hederaAccountId` (0.0.x). With ECDSA
 * secp256k1 keys these are two views of the same account — the EVM address
 * is the account alias, and the 0.0.x id materialises once the account is
 * auto-created by its first inbound HBAR transfer.
 */

export type HederaNetwork = "testnet" | "mainnet" | "previewnet";

/** A wallet identity as seen by callers. `hederaAccountId` is null until the
 * account has been auto-created on-ledger (first inbound HBAR). */
export interface WalletIdentity {
  /** Checksummed 0x EVM address derived from the secp256k1 public key. */
  evmAddress: string;
  /** Hedera account id (0.0.x), or null if the account has not been created yet. */
  hederaAccountId: string | null;
}

export interface Balance {
  /** Balance as a decimal HBAR string, e.g. "12.34567890". */
  hbar: string;
  /** Raw tinybar amount (1 HBAR = 100_000_000 tinybar). */
  tinybar: bigint;
  /** Optional fiat estimate; null when no price source is configured. */
  usdEstimate: number | null;
}

export type TransferDirection = "in" | "out";

export interface HistoryItem {
  /** Hedera transaction id, e.g. "0.0.1234@1700000000.000000000". */
  transactionId: string;
  /** Signed decimal amount for this account — HBAR unless `token` is set,
   * in which case it's denominated in that token. */
  amount: string;
  /** Raw signed amount: tinybar for HBAR items, the token's smallest units
   * when `token` is set. */
  tinybar: bigint;
  direction: TransferDirection;
  /** Set when this movement is an HTS token transfer (absent = HBAR). */
  token?: { tokenId: string; symbol: string; decimals: number };
  /** Counterparty account id or evm address, best-effort. */
  counterparty: string | null;
  /** ISO-8601 timestamp of consensus. */
  timestamp: string;
  /** Consensus timestamp in Hedera's seconds.nanos form (useful as a cursor). */
  consensusTimestamp: string;
  hashscanUrl: string;
  memo?: string;
}

export interface SendResult {
  transactionId: string;
  hashscanUrl: string;
  status: string;
}

/** Public metadata of an HTS token, from the Mirror Node. */
export interface TokenInfo {
  tokenId: string;
  name: string;
  symbol: string;
  decimals: number;
  /** "FUNGIBLE_COMMON" | "NON_FUNGIBLE_UNIQUE" (we only surface fungibles). */
  type: string;
}

/** Native-staking state of an account, from the Mirror Node. */
export interface StakingInfo {
  /** Node the account stakes to, or null when not staking. */
  stakedNodeId: number | null;
  /** Reward earned but not yet paid out, in tinybar. */
  pendingRewardTinybar: bigint;
  /** Pending reward as a decimal HBAR string. */
  pendingRewardHbar: string;
  declineReward: boolean;
}

/** A consensus node an account can stake to. */
export interface NetworkNode {
  nodeId: number;
  description: string;
}

/** An NFT the account holds (view-only in this wallet). */
export interface NftItem {
  tokenId: string;
  serialNumber: number;
  /** Collection name/symbol from the token's metadata. */
  name: string;
  symbol: string;
  /** Hashscan page for this exact serial. */
  hashscanUrl: string;
}

/** An HTS token the account holds (is associated with). */
export interface TokenBalance extends TokenInfo {
  /** Balance in the token's smallest units. */
  balanceRaw: bigint;
  /** Balance as an exact decimal string, e.g. "12.5" for 6-decimals USDC. */
  balance: string;
  /** Fiat estimate — 1:1 for USDC, null for tokens with no price source. */
  usdEstimate: number | null;
}

export interface IncomingTransfer extends HistoryItem {
  direction: "in";
}

/** Opaque, serialisable record persisted by a KeyProvider. Contains only
 * ciphertext + public metadata — never plaintext key material. */
export interface EncryptedWalletRecord {
  version: 1;
  /** Public EVM address (safe to store in the clear). */
  evmAddress: string;
  /** KDF + cipher parameters needed to re-derive and decrypt. */
  kdf: KdfParams;
  /** Base64url XChaCha20-Poly1305 nonce. */
  nonce: string;
  /** Base64url ciphertext of the 32-byte private key (includes Poly1305 tag). */
  ciphertext: string;
  /** Which secret source produced the wrapping key. */
  secretSource: SecretSource;
  createdAt: string;
}

export type SecretSource = "password" | "passkey-prf";

export interface KdfParams {
  algorithm: "argon2id";
  /** Base64url salt. */
  salt: string;
  /** Argon2 time cost (iterations). */
  iterations: number;
  /** Argon2 memory cost in KiB. */
  memorySize: number;
  parallelism: number;
  /** Derived key length in bytes (32 for XChaCha20). */
  hashLength: number;
}
