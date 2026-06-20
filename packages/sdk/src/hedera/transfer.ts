/**
 * HBAR send path via @hashgraph/sdk's native TransferTransaction.
 *
 * Sending to a 0x EVM address that has no account yet AUTO-CREATES the
 * recipient account on first receipt — this is the property that powers the
 * "create a wallet and pay them in one step" flow. We sign locally with the
 * sender's ECDSA key; no key ever leaves the device.
 */
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  TransferTransaction,
} from "@hashgraph/sdk";
import type { HederaNetwork, SendResult } from "../types.js";
import { getNetworkConfig, hashscanTxUrl } from "./networks.js";

function clientFor(network: HederaNetwork): Client {
  switch (network) {
    case "testnet":
      return Client.forTestnet();
    case "mainnet":
      return Client.forMainnet();
    case "previewnet":
      return Client.forPreviewnet();
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}

/** Parse a recipient given as a 0.0.x id or a 0x EVM address. */
function recipientAccountId(to: string): AccountId {
  const t = to.trim();
  if (t.startsWith("0x") || t.startsWith("0X")) {
    return AccountId.fromEvmAddress(0, 0, t);
  }
  return AccountId.fromString(t);
}

export interface SendArgs {
  network: HederaNetwork;
  senderAccountId: string;
  senderPrivateKeyHex: string;
  to: string;
  amountHbar: string | number;
  memo?: string;
}

export async function sendHbar(args: SendArgs): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const senderKey = PrivateKey.fromStringECDSA(args.senderPrivateKeyHex);
  const senderId = AccountId.fromString(args.senderAccountId);
  client.setOperator(senderId, senderKey);

  try {
    const amount = Hbar.fromString(String(args.amountHbar));
    const negated = Hbar.fromTinybars(amount.toTinybars().negate());
    let tx = new TransferTransaction()
      .addHbarTransfer(senderId, negated)
      .addHbarTransfer(recipientAccountId(args.to), amount);
    if (args.memo) tx = tx.setTransactionMemo(args.memo);

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
