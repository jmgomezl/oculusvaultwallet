/**
 * Agent Desk Tier 2 — HIP-336 allowances.
 *
 * Instead of holding petty cash, the agent spends FROM THE OWNER'S account
 * up to a per-token cap, via approved transfers it signs itself. Custody
 * never moves: the owner's balance stays the owner's, the network enforces
 * the cap, and revoking is instant (approve 0). Verified live on testnet
 * (2026-07-10): the mirror's `amount` field is the live REMAINING allowance,
 * decremented as the spender uses it; `amount_granted` is the original cap.
 *
 * The spender here is an agent account, but nothing in HIP-336 requires
 * that — any account id can be approved.
 */
import {
  AccountAllowanceApproveTransaction,
  AccountId,
  Hbar,
  Long,
  PrivateKey,
  TokenId,
} from "@hashgraph/sdk";
import type { HederaNetwork, SendResult } from "../types.js";
import { getNetworkConfig, hashscanTxUrl } from "./networks.js";
import { clientFor } from "./transfer.js";

function friendlyAllowanceError(err: unknown): Error {
  const msg = String((err as Error)?.message ?? err);
  if (/INVALID_ALLOWANCE_SPENDER_ID|INVALID_ACCOUNT_ID|ACCOUNT_ID_DOES_NOT_EXIST/.test(msg)) {
    return new Error("That spender account doesn't exist on this network.");
  }
  if (/NEGATIVE_ALLOWANCE_AMOUNT/.test(msg)) {
    return new Error("Allowance amounts can't be negative — use 0 to revoke.");
  }
  if (/INSUFFICIENT_PAYER_BALANCE|INSUFFICIENT_ACCOUNT_BALANCE/.test(msg)) {
    return new Error("Not enough HBAR to pay the network fee.");
  }
  if (/TOKEN_NOT_ASSOCIATED_TO_ACCOUNT/.test(msg)) {
    return new Error("Your wallet isn't associated with that token.");
  }
  return err instanceof Error ? err : new Error(msg);
}

export interface ApproveAllowanceArgs {
  network: HederaNetwork;
  /** The owner whose balance the spender may draw from (signs this). */
  ownerAccountId: string;
  ownerPrivateKeyHex: string;
  /** The approved spender (an agent account id). */
  spenderAccountId: string;
  /** HBAR cap as a decimal string, or "0" to revoke. */
  amountHbar?: string | number;
  /** HTS token cap: token id + amount in the token's smallest units. */
  token?: { tokenId: string; amountRaw: bigint };
}

/**
 * Grant (or, with amount 0, revoke) an allowance. Exactly one of
 * `amountHbar` / `token` must be provided. The cap REPLACES any previous
 * allowance for that owner→spender pair; it never stacks.
 */
export async function approveAllowance(
  args: ApproveAllowanceArgs,
): Promise<SendResult> {
  if ((args.amountHbar == null) === (args.token == null)) {
    throw new Error("Provide exactly one of amountHbar or token");
  }
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const ownerKey = PrivateKey.fromStringECDSA(args.ownerPrivateKeyHex);
  const ownerId = AccountId.fromString(args.ownerAccountId);
  client.setOperator(ownerId, ownerKey);
  try {
    const spender = AccountId.fromString(args.spenderAccountId);
    let tx = new AccountAllowanceApproveTransaction();
    if (args.amountHbar != null) {
      const amount = Hbar.fromString(String(args.amountHbar));
      if (amount.toTinybars().toNumber() < 0) {
        throw new Error("Allowance amounts can't be negative — use 0 to revoke.");
      }
      tx = tx.approveHbarAllowance(ownerId, spender, amount);
    } else {
      const { tokenId, amountRaw } = args.token!;
      if (amountRaw < 0n) {
        throw new Error("Allowance amounts can't be negative — use 0 to revoke.");
      }
      tx = tx.approveTokenAllowance(
        TokenId.fromString(tokenId),
        ownerId,
        spender,
        Long.fromString(amountRaw.toString()),
      );
    }
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyAllowanceError(err);
  } finally {
    client.close();
  }
}
