/**
 * Native Hedera staking. An account can stake its whole balance to a network
 * node with a single AccountUpdateTransaction — no lockup, no transfer, no
 * slashing; rewards accrue daily and land with the next transaction the
 * account is involved in. Stopping is the same transaction with the staked
 * node cleared.
 */
import { AccountId, AccountUpdateTransaction, PrivateKey } from "@hashgraph/sdk";
import type { HederaNetwork, SendResult } from "../types.js";
import { getNetworkConfig, hashscanTxUrl } from "./networks.js";
import { clientFor } from "./transfer.js";

export interface SetStakingArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  /** Node to stake to, or null to stop staking. */
  nodeId: number | null;
}

export async function setStaking(args: SetStakingArgs): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  const accountId = AccountId.fromString(args.accountId);
  client.setOperator(accountId, key);

  try {
    const tx = new AccountUpdateTransaction().setAccountId(accountId);
    if (args.nodeId == null) tx.clearStakedNodeId();
    else tx.setStakedNodeId(args.nodeId);
    const response = await tx.execute(client);
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
