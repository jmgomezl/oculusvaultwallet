/**
 * Hedera-EVM helpers for the JSON-RPC relay path (Hashio). This is how a
 * signer that only speaks Ethereum — like the Ledger Ethereum app — drives a
 * Hedera account: value transfers move HBAR, HTS tokens are ERC-20 facades at
 * their long-zero address, and contract calls are plain EVM transactions.
 *
 * Unit discipline: the relay speaks 18-decimal "weibars"; Hedera natively
 * uses 8-decimal tinybars. 1 tinybar = 10^10 weibar. All conversions are
 * exact bigints via the same parser the token path uses.
 */
import type { HederaNetwork } from "../types.js";
import { formatTokenAmount, parseTokenAmount } from "./tokenAmount.js";

/** EVM chain ids of the Hedera JSON-RPC relay (EIP-155). */
export const EVM_CHAIN_IDS: Record<HederaNetwork, number> = {
  mainnet: 295,
  testnet: 296,
  previewnet: 297,
};

/** "1.5" HBAR → 1500000000000000000n weibar (exact; rejects >18 decimals). */
export function hbarToWeibar(hbar: string | number): bigint {
  return parseTokenAmount(hbar, 18);
}

/** 1500000000000000000n weibar → "1.5". */
export function weibarToHbar(weibar: bigint): string {
  return formatTokenAmount(weibar, 18);
}

/**
 * Long-zero EVM address of a Hedera entity id — how HTS tokens (and accounts
 * without an ECDSA alias) appear to the EVM: 0x followed by the entity number,
 * left-padded to 20 bytes (shard/realm 0).
 */
export function entityEvmAddress(entityId: string): string {
  const m = /^0\.0\.([0-9]+)$/.exec(entityId.trim());
  if (!m) throw new Error(`Not a Hedera entity id: "${entityId}"`);
  return `0x${BigInt(m[1]!).toString(16).padStart(40, "0")}`;
}

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** ERC-20 `transfer(address,uint256)` calldata — sends an HTS token through
 * its EVM facade. Amount is in the token's smallest units. */
export function erc20TransferData(toEvm: string, amountRaw: bigint): string {
  if (!EVM_ADDR_RE.test(toEvm)) {
    throw new Error(`Not an EVM address: "${toEvm}"`);
  }
  if (amountRaw <= 0n) throw new Error("Token amount must be positive");
  return (
    "0xa9059cbb" + // keccak256("transfer(address,uint256)")[0:4]
    toEvm.slice(2).toLowerCase().padStart(64, "0") +
    amountRaw.toString(16).padStart(64, "0")
  );
}
