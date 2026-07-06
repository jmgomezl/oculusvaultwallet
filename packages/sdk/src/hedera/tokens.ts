/**
 * HTS fungible-token write path via @hashgraph/sdk: association + transfer.
 *
 * Same custody model as the HBAR path — we sign locally with the sender's
 * ECDSA key; no key ever leaves the device. Amounts travel as bigints in the
 * token's smallest units (see tokenAmount.ts) — never floats.
 *
 * Hedera specifics worth knowing:
 * - A recipient must be ASSOCIATED with a token to receive it (or have
 *   automatic-association slots free — accounts auto-created via EVM alias
 *   get unlimited auto-association since HIP-904).
 * - Association is an on-ledger transaction paid by the associating account,
 *   so it needs a little HBAR for the fee.
 */
import {
  AccountId,
  Long,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  TransferTransaction,
} from "@hashgraph/sdk";
import type { HederaNetwork, SendResult } from "../types.js";
import { getNetworkConfig, hashscanTxUrl } from "./networks.js";
import { clientFor, recipientAccountId } from "./transfer.js";

/** Well-known fungible tokens, verified against the Mirror Node. */
export const USDC_TOKEN_IDS: Partial<Record<HederaNetwork, string>> = {
  mainnet: "0.0.456858", // USD Coin (USDC), 6 decimals
  testnet: "0.0.429274", // USD Coin (USDC), 6 decimals
};

/** Map Hedera status codes to sentences a wallet user can act on. */
function friendlyTokenError(err: unknown): Error {
  const msg = String((err as Error)?.message ?? err);
  if (/TOKEN_NOT_ASSOCIATED_TO_ACCOUNT|NO_REMAINING_AUTOMATIC_ASSOCIATIONS/.test(msg)) {
    return new Error(
      "The recipient hasn’t enabled this token — they need to add it in their wallet first.",
    );
  }
  if (/INSUFFICIENT_TOKEN_BALANCE/.test(msg)) {
    return new Error("Not enough of this token to send that amount.");
  }
  if (/INSUFFICIENT_PAYER_BALANCE|INSUFFICIENT_ACCOUNT_BALANCE/.test(msg)) {
    return new Error("Not enough HBAR to pay the network fee.");
  }
  if (/TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT/.test(msg)) {
    return new Error("This token is already added to your wallet.");
  }
  return err instanceof Error ? err : new Error(msg);
}

export interface SendTokenArgs {
  network: HederaNetwork;
  senderAccountId: string;
  senderPrivateKeyHex: string;
  to: string;
  tokenId: string;
  /** Amount in the token's smallest units (use parseTokenAmount). */
  amountRaw: bigint;
  memo?: string;
}

export async function sendToken(args: SendTokenArgs): Promise<SendResult> {
  if (args.amountRaw <= 0n) throw new Error("Token amount must be positive");
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const senderKey = PrivateKey.fromStringECDSA(args.senderPrivateKeyHex);
  const senderId = AccountId.fromString(args.senderAccountId);
  client.setOperator(senderId, senderKey);

  try {
    const token = TokenId.fromString(args.tokenId);
    const amount = Long.fromString(args.amountRaw.toString());
    let tx = new TransferTransaction()
      .addTokenTransfer(token, senderId, amount.negate())
      .addTokenTransfer(token, recipientAccountId(args.to), amount);
    if (args.memo) tx = tx.setTransactionMemo(args.memo);

    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyTokenError(err);
  } finally {
    client.close();
  }
}

export interface AssociateTokenArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  tokenId: string;
}

/** Opt the account in to a token so it can receive it. Costs a small HBAR fee. */
export async function associateToken(
  args: AssociateTokenArgs,
): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  const accountId = AccountId.fromString(args.accountId);
  client.setOperator(accountId, key);

  try {
    const tx = new TokenAssociateTransaction()
      .setAccountId(accountId)
      .setTokenIds([TokenId.fromString(args.tokenId)]);
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyTokenError(err);
  } finally {
    client.close();
  }
}
