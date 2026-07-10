/**
 * Agent Desk — Tier 1 "petty cash" accounts for AI agents.
 *
 * An agent account is a REAL Hedera account whose key is a 1-of-2 KeyList
 * [ownerPublicKey, agentPublicKey]. The agent operates autonomously within
 * the balance the owner funded, while the owner stays a protocol-level
 * co-owner: either key alone satisfies the account, so the owner can freeze
 * (rotate the agent key out), sweep funds home, refill, or retire the account
 * — all WITHOUT the agent's cooperation. Every guarantee here is enforced
 * on-chain by the key structure, never by policy.
 *
 * Verified live on testnet (2026-07-10): create/spend/sweep/freeze/unfreeze/
 * delete all work with the OWNER SIGNATURE ALONE (the payer signature
 * satisfies both the 1-of-2 threshold and the new-key requirement on
 * rotation), and a frozen agent's transfer fails with INVALID_SIGNATURE.
 *
 * KeyList accounts have NO EVM alias / auto-create path — they are created
 * explicitly with the owner paying (~$0.05).
 */
import {
  AccountCreateTransaction,
  AccountDeleteTransaction,
  AccountId,
  AccountUpdateTransaction,
  Hbar,
  KeyList,
  PrivateKey,
  PublicKey,
  TransferTransaction,
} from "@hashgraph/sdk";
import type { HederaNetwork, SendResult } from "../types.js";
import { getNetworkConfig, hashscanTxUrl } from "./networks.js";
import { clientFor } from "./transfer.js";

/** Map Hedera status codes to sentences an owner can act on. */
function friendlyAgentError(err: unknown): Error {
  const msg = String((err as Error)?.message ?? err);
  if (/INVALID_SIGNATURE/.test(msg)) {
    return new Error(
      "The network rejected the signature — the agent account's key may have been rotated.",
    );
  }
  if (/ACCOUNT_DELETED/.test(msg)) {
    return new Error("This agent account has already been retired.");
  }
  if (/INVALID_ACCOUNT_ID|ACCOUNT_ID_DOES_NOT_EXIST/.test(msg)) {
    return new Error("That agent account doesn't exist on this network.");
  }
  if (/INSUFFICIENT_PAYER_BALANCE|INSUFFICIENT_ACCOUNT_BALANCE/.test(msg)) {
    return new Error("Not enough HBAR to fund this operation and its network fee.");
  }
  if (/TRANSACTION_REQUIRES_ZERO_TOKEN_BALANCES/.test(msg)) {
    return new Error(
      "The agent still holds HTS tokens — sweep or transfer them out before retiring it.",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/** The 1-of-2 KeyList that makes the owner a protocol-level co-owner. */
export function agentKeyList(
  ownerPublicKey: PublicKey,
  agentPublicKey: PublicKey,
): KeyList {
  return new KeyList([ownerPublicKey, agentPublicKey], 1);
}

export interface CreateAgentAccountArgs {
  network: HederaNetwork;
  /** The owner's funded account — pays for creation and the initial balance. */
  ownerAccountId: string;
  ownerPrivateKeyHex: string;
  /** Petty cash to start the agent with, in HBAR (its whole budget). */
  initialHbar: string | number;
  /** Public account memo shown on explorers. */
  memo?: string;
}

export interface CreateAgentAccountResult extends SendResult {
  /** The new agent account id (0.0.x). */
  accountId: string;
  /** SHOW-ONCE credential: the agent's raw ECDSA private key (hex, no 0x).
   * Hand it to the agent runtime and forget it — the owner can always rotate
   * in a fresh key via freeze/unfreeze co-ownership, so re-issue > recovery. */
  agentPrivateKeyHex: string;
  /** The agent's public key (hex) — safe to keep; needed to unfreeze. */
  agentPublicKeyHex: string;
}

/** Create a Tier-1 petty-cash agent account. Generates a fresh agent key,
 * sets the account key to KeyList(1-of-2)[owner, agent], funds it from the
 * owner's balance, and returns the agent credentials for one-time handoff. */
export async function createAgentAccount(
  args: CreateAgentAccountArgs,
): Promise<CreateAgentAccountResult> {
  const initial = Hbar.fromString(String(args.initialHbar));
  if (initial.toTinybars().toNumber() <= 0) {
    throw new Error("Initial petty cash must be a positive HBAR amount");
  }
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const ownerKey = PrivateKey.fromStringECDSA(args.ownerPrivateKeyHex);
  client.setOperator(AccountId.fromString(args.ownerAccountId), ownerKey);

  const agentKey = PrivateKey.generateECDSA();
  try {
    let tx = new AccountCreateTransaction()
      .setKeyWithoutAlias(agentKeyList(ownerKey.publicKey, agentKey.publicKey))
      .setInitialBalance(initial);
    if (args.memo) tx = tx.setAccountMemo(args.memo);
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.accountId) throw new Error("Network returned no account id");
    const transactionId = response.transactionId.toString();
    return {
      accountId: receipt.accountId.toString(),
      agentPrivateKeyHex: agentKey.toStringRaw(),
      agentPublicKeyHex: agentKey.publicKey.toStringRaw(),
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyAgentError(err);
  } finally {
    client.close();
  }
}

export interface AgentControlArgs {
  network: HederaNetwork;
  ownerAccountId: string;
  ownerPrivateKeyHex: string;
  agentAccountId: string;
}

/**
 * Freeze: rotate the account key to the OWNER's key alone. The agent's key
 * stops satisfying the account instantly — its next transaction fails with
 * INVALID_SIGNATURE. Owner signature alone authorizes this (it satisfies the
 * current 1-of-2 threshold AND the new key).
 */
export async function freezeAgent(args: AgentControlArgs): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const ownerKey = PrivateKey.fromStringECDSA(args.ownerPrivateKeyHex);
  client.setOperator(AccountId.fromString(args.ownerAccountId), ownerKey);
  try {
    const response = await new AccountUpdateTransaction()
      .setAccountId(AccountId.fromString(args.agentAccountId))
      .setKey(ownerKey.publicKey)
      .execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyAgentError(err);
  } finally {
    client.close();
  }
}

export interface UnfreezeAgentArgs extends AgentControlArgs {
  /** The agent public key to restore into the 1-of-2 KeyList. Pass the
   * ORIGINAL key to re-enable the same agent, or a FRESH key to re-issue
   * credentials (lost-key recovery: re-issue > recovery). */
  agentPublicKeyHex: string;
}

/** Unfreeze: restore the 1-of-2 KeyList [owner, agent]. Also the re-issue
 * path — pass a new agent public key to rotate a lost/compromised one out. */
export async function unfreezeAgent(args: UnfreezeAgentArgs): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const ownerKey = PrivateKey.fromStringECDSA(args.ownerPrivateKeyHex);
  client.setOperator(AccountId.fromString(args.ownerAccountId), ownerKey);
  try {
    const agentPub = PublicKey.fromString(args.agentPublicKeyHex);
    const response = await new AccountUpdateTransaction()
      .setAccountId(AccountId.fromString(args.agentAccountId))
      .setKey(agentKeyList(ownerKey.publicKey, agentPub))
      .execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyAgentError(err);
  } finally {
    client.close();
  }
}

export interface SweepAgentArgs extends AgentControlArgs {
  /** Amount to pull back, in tinybar (exact bigint — no floats). */
  amountTinybar: bigint;
  memo?: string;
}

/** Sweep funds home: a transfer FROM the agent account TO the owner, signed
 * by the owner alone (the owner key satisfies the agent's 1-of-2 KeyList).
 * Works on frozen agents too — freezing rotates to the owner's key. */
export async function sweepAgent(args: SweepAgentArgs): Promise<SendResult> {
  if (args.amountTinybar <= 0n) throw new Error("Sweep amount must be positive");
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const ownerKey = PrivateKey.fromStringECDSA(args.ownerPrivateKeyHex);
  const ownerId = AccountId.fromString(args.ownerAccountId);
  client.setOperator(ownerId, ownerKey);
  try {
    const amount = Hbar.fromTinybars(args.amountTinybar.toString());
    const negated = Hbar.fromTinybars((-args.amountTinybar).toString());
    let tx = new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(args.agentAccountId), negated)
      .addHbarTransfer(ownerId, amount);
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
    throw friendlyAgentError(err);
  } finally {
    client.close();
  }
}

/** Retire: delete the agent account, sweeping any remaining balance to the
 * owner. Owner signature alone authorizes it. Irreversible. */
export async function retireAgent(args: AgentControlArgs): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const ownerKey = PrivateKey.fromStringECDSA(args.ownerPrivateKeyHex);
  const ownerId = AccountId.fromString(args.ownerAccountId);
  client.setOperator(ownerId, ownerKey);
  try {
    const tx = new AccountDeleteTransaction()
      .setAccountId(AccountId.fromString(args.agentAccountId))
      .setTransferAccountId(ownerId)
      .freezeWith(client);
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyAgentError(err);
  } finally {
    client.close();
  }
}
