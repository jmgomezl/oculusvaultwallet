/**
 * Agent Desk Tier 3 — "ask-me" approvals via Scheduled Transactions.
 *
 * For operations above what its petty cash or allowance covers, an agent
 * creates a SCHEDULED transaction that only executes once the owner co-signs
 * it from the wallet. The pending schedule sits on-chain (visible via the
 * mirror), the wallet surfaces it like a consent request, and the owner's
 * ScheduleSignTransaction is what makes it execute — or it simply expires
 * (30 minutes after creation unless the agent set an explicit expiry).
 *
 * The scheduled payload arrives from the mirror as a base64
 * SchedulableTransactionBody protobuf; we decode it with @hashgraph/proto
 * (the SDK's own wire library) rather than trusting the requester's memo —
 * the summary the owner approves is derived from the BYTES that will run.
 */
import {
  AccountId,
  PrivateKey,
  ScheduleId,
  ScheduleSignTransaction,
} from "@hashgraph/sdk";
import * as HashgraphProto from "@hashgraph/proto";
import type { HederaNetwork, SendResult } from "../types.js";
import { getNetworkConfig, hashscanTxUrl } from "./networks.js";
import { clientFor } from "./transfer.js";

const { proto } = HashgraphProto;

function friendlyScheduleError(err: unknown): Error {
  const msg = String((err as Error)?.message ?? err);
  if (/SCHEDULE_ALREADY_EXECUTED/.test(msg)) {
    return new Error("This request was already approved and executed.");
  }
  if (/SCHEDULE_ALREADY_DELETED|INVALID_SCHEDULE_ID/.test(msg)) {
    return new Error("This request no longer exists — it expired or was withdrawn.");
  }
  if (/NO_NEW_VALID_SIGNATURES/.test(msg)) {
    return new Error("Your signature doesn't add anything to this request — it may not involve your account.");
  }
  if (/INSUFFICIENT_PAYER_BALANCE|INSUFFICIENT_ACCOUNT_BALANCE/.test(msg)) {
    return new Error("Not enough HBAR to pay the network fee.");
  }
  return err instanceof Error ? err : new Error(msg);
}

export interface SignScheduleArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  scheduleId: string;
}

/** Owner-side approval: add this wallet's signature to a pending schedule.
 * If that signature completes the inner transaction's requirements, the
 * network executes it in the same consensus round. */
export async function signSchedule(args: SignScheduleArgs): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  client.setOperator(AccountId.fromString(args.accountId), key);
  try {
    const response = await new ScheduleSignTransaction()
      .setScheduleId(ScheduleId.fromString(args.scheduleId))
      .freezeWith(client)
      .execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } catch (err) {
    throw friendlyScheduleError(err);
  } finally {
    client.close();
  }
}

/** One movement inside a scheduled transfer, in exact raw units. */
export interface ScheduledMovement {
  accountId: string;
  /** Tinybar for HBAR rows; the token's smallest units for token rows. */
  amountRaw: bigint;
  tokenId?: string;
}

/** Structural summary of what a pending schedule would DO if approved. */
export interface ScheduledSummary {
  kind: "transfer" | "other";
  /** Set for kind "other": the protobuf field that carries the operation
   * (e.g. "tokenMint") — still shown to the owner, just not itemised. */
  operation?: string;
  movements: ScheduledMovement[];
  memo?: string;
}

/** protobufjs Long → exact bigint (never a float). */
function longToBigInt(v: unknown): bigint {
  if (v == null) return 0n;
  if (typeof v === "number" || typeof v === "bigint") return BigInt(v);
  const l = v as { low: number; high: number; unsigned?: boolean };
  const low = BigInt(l.low >>> 0);
  const high = BigInt(l.high | 0);
  return (high << 32n) + low;
}

function accountIdString(a: HashgraphProto.proto.IAccountID | null | undefined): string {
  if (!a) return "?";
  return `${longToBigInt(a.shardNum ?? 0)}.${longToBigInt(a.realmNum ?? 0)}.${longToBigInt(a.accountNum ?? 0)}`;
}

function tokenIdString(t: HashgraphProto.proto.ITokenID | null | undefined): string {
  if (!t) return "?";
  return `${longToBigInt(t.shardNum ?? 0)}.${longToBigInt(t.realmNum ?? 0)}.${longToBigInt(t.tokenNum ?? 0)}`;
}

/**
 * Decode a mirror `transaction_body` (base64 SchedulableTransactionBody)
 * into the summary the consent card shows. Derived from the bytes that will
 * execute — never from the requester's memo.
 */
export function describeScheduledBody(transactionBodyBase64: string): ScheduledSummary {
  const bytes = Uint8Array.from(atob(transactionBodyBase64), (c) => c.charCodeAt(0));
  const body = proto.SchedulableTransactionBody.decode(bytes);
  const memo = body.memo || undefined;

  if (body.cryptoTransfer) {
    const movements: ScheduledMovement[] = [];
    for (const aa of body.cryptoTransfer.transfers?.accountAmounts ?? []) {
      movements.push({
        accountId: accountIdString(aa.accountID),
        amountRaw: longToBigInt(aa.amount),
      });
    }
    for (const tt of body.cryptoTransfer.tokenTransfers ?? []) {
      const tokenId = tokenIdString(tt.token);
      for (const aa of tt.transfers ?? []) {
        movements.push({
          accountId: accountIdString(aa.accountID),
          amountRaw: longToBigInt(aa.amount),
          tokenId,
        });
      }
    }
    return { kind: "transfer", movements, memo };
  }

  // Anything else still surfaces honestly, just without itemisation.
  const operation = Object.keys(body).find(
    (k) => k !== "memo" && k !== "transactionFee" && k !== "maxCustomFees" && (body as any)[k] != null,
  );
  return { kind: "other", operation, movements: [], memo };
}
