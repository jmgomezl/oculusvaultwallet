/**
 * Hedera Consensus Service (HCS) — the "notary" path. A topic is a public,
 * append-only log; every message submitted to it gets an immutable consensus
 * timestamp and sequence number. Creating a topic here sets BOTH the admin
 * and submit keys to the wallet's key, so only the owner can post to (or
 * later update) their notebook; reading is public by design.
 */
import {
  PrivateKey,
  PublicKey,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TopicId,
  AccountId,
} from "@hashgraph/sdk";
import type { HederaNetwork, SendResult } from "../types.js";
import { getNetworkConfig, hashscanTxUrl } from "./networks.js";
import { clientFor } from "./transfer.js";

export interface CreateTopicArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  /** Public memo shown on explorers (e.g. what this notebook is for). */
  memo?: string;
  /** Who may WRITE to the topic. Defaults to the creating wallet's key;
   * pass another public key (hex) to delegate writing — e.g. an Agent Desk
   * audit topic where the AGENT writes and the owner keeps the admin key. */
  submitKeyPublicHex?: string;
}

export interface CreateTopicResult extends SendResult {
  topicId: string;
}

export async function createTopic(
  args: CreateTopicArgs,
): Promise<CreateTopicResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  client.setOperator(AccountId.fromString(args.accountId), key);

  try {
    let tx = new TopicCreateTransaction()
      .setAdminKey(key.publicKey)
      .setSubmitKey(
        args.submitKeyPublicHex
          ? PublicKey.fromString(args.submitKeyPublicHex)
          : key.publicKey,
      );
    if (args.memo) tx = tx.setTopicMemo(args.memo);
    const response = await tx.execute(client);
    const receipt = await response.getReceipt(client);
    if (!receipt.topicId) throw new Error("Network returned no topic id");
    const transactionId = response.transactionId.toString();
    return {
      topicId: receipt.topicId.toString(),
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } finally {
    client.close();
  }
}

export interface SubmitTopicMessageArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  topicId: string;
  /** UTF-8 message, max ~1024 bytes per chunk (we cap at one chunk). */
  message: string;
}

export async function submitTopicMessage(
  args: SubmitTopicMessageArgs,
): Promise<SendResult> {
  const bytes = new TextEncoder().encode(args.message);
  if (bytes.length === 0) throw new Error("Message is empty");
  if (bytes.length > 1024) {
    throw new Error("Keep messages under 1024 bytes (one consensus chunk)");
  }
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  client.setOperator(AccountId.fromString(args.accountId), key);

  try {
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(args.topicId))
      .setMessage(bytes)
      .execute(client);
    const receipt = await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    return {
      transactionId,
      hashscanUrl: hashscanTxUrl(cfg, transactionId),
      status: receipt.status.toString(),
    };
  } finally {
    client.close();
  }
}
