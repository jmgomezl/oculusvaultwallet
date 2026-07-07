/**
 * Human summary of a Hedera transaction — the "what am I signing?" text a
 * wallet shows before approving a dApp request. Best-effort and safe: an
 * unrecognised transaction still yields a generic label, never an exception.
 *
 * Type detection uses instanceof against known classes, NOT constructor.name —
 * minified builds mangle class names (verified: "TransferTransaction" becomes
 * "T" in the CJS/production bundles).
 */
import {
  AccountAllowanceApproveTransaction,
  AccountUpdateTransaction,
  ContractExecuteTransaction,
  TokenAssociateTransaction,
  TokenBurnTransaction,
  TokenCreateTransaction,
  TokenMintTransaction,
  TopicMessageSubmitTransaction,
  Transaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { tinybarToHbar } from "./mirror.js";

const KNOWN_TYPES: Array<[abstract new (...args: never[]) => Transaction, string]> = [
  [TransferTransaction, "Transfer"],
  [TokenAssociateTransaction, "Token associate"],
  [AccountAllowanceApproveTransaction, "Allowance approval — lets a contract/account spend on your behalf"],
  [ContractExecuteTransaction, "Smart-contract call"],
  [AccountUpdateTransaction, "Account update (staking/keys/settings)"],
  [TokenCreateTransaction, "Token create"],
  [TokenMintTransaction, "Token mint"],
  [TokenBurnTransaction, "Token burn"],
  [TopicMessageSubmitTransaction, "Consensus message"],
];

function humanType(tx: Transaction): string {
  for (const [cls, label] of KNOWN_TYPES) {
    if (tx instanceof cls) return label;
  }
  // Unminified builds still get a readable name; minified ones fall through.
  const raw = tx.constructor?.name ?? "";
  if (raw.length > 3) {
    const words = raw
      .replace(/Transaction$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2");
    return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
  }
  return "Hedera transaction";
}

export function describeTransaction(tx: Transaction): string {
  try {
    const parts: string[] = [humanType(tx)];

    if (tx instanceof TransferTransaction) {
      const moves: string[] = [];
      for (const [account, amount] of tx.hbarTransfers) {
        const tiny = BigInt(amount.toTinybars().toString());
        if (tiny === 0n) continue;
        moves.push(
          `${account.toString()} ${tiny > 0n ? "+" : ""}${tinybarToHbar(tiny)} ℏ`,
        );
      }
      for (const [tokenId, transfers] of tx.tokenTransfers) {
        for (const [account, amount] of transfers) {
          const raw = BigInt(amount.toString());
          if (raw === 0n) continue;
          moves.push(
            `${account.toString()} ${raw > 0n ? "+" : ""}${raw} of token ${tokenId.toString()} (smallest units)`,
          );
        }
      }
      if (moves.length > 0) parts.push(moves.join("; "));
    }

    const memo = tx.transactionMemo;
    if (memo) parts.push(`memo: “${memo}”`);
    return parts.join(" — ");
  } catch {
    return "Hedera transaction (details unavailable — review carefully)";
  }
}
