/**
 * Smart Contract Service — native contract execution signed by the wallet
 * key. Takes ABI-encoded calldata (the same 0x… bytes any EVM tool produces)
 * so the wallet stays ABI-agnostic; dApps and ABI tools do the encoding.
 */
import {
  AccountId,
  ContractExecuteTransaction,
  ContractId,
  Hbar,
  HbarUnit,
  PrivateKey,
} from "@hashgraph/sdk";
import type { HederaNetwork, SendResult } from "../types.js";
import { getNetworkConfig, hashscanTxUrl } from "./networks.js";
import { clientFor } from "./transfer.js";

function contractIdFrom(target: string): ContractId {
  const t = target.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return ContractId.fromEvmAddress(0, 0, t);
  return ContractId.fromString(t);
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.trim().replace(/^0x/i, "");
  if (h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) {
    throw new Error("Calldata must be 0x-prefixed hex");
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export interface ExecuteContractArgs {
  network: HederaNetwork;
  accountId: string;
  privateKeyHex: string;
  /** Contract as 0.0.x id or 0x EVM address. */
  contract: string;
  /** ABI-encoded calldata (0x…), e.g. from a dApp or ABI tool. */
  calldata?: string;
  /** HBAR to send along (payable calls), decimal string. */
  payableHbar?: string;
  /** Gas limit; contract calls on Hedera commonly need 100k–1M. */
  gas?: number;
}

export async function executeContract(
  args: ExecuteContractArgs,
): Promise<SendResult> {
  const cfg = getNetworkConfig(args.network);
  const client = clientFor(args.network);
  const key = PrivateKey.fromStringECDSA(args.privateKeyHex);
  client.setOperator(AccountId.fromString(args.accountId), key);

  try {
    let tx = new ContractExecuteTransaction()
      .setContractId(contractIdFrom(args.contract))
      .setGas(args.gas ?? 120_000);
    if (args.calldata && args.calldata.trim() !== "" && args.calldata.trim() !== "0x") {
      tx = tx.setFunctionParameters(hexToBytes(args.calldata));
    }
    if (args.payableHbar && Number(args.payableHbar) > 0) {
      tx = tx.setPayableAmount(Hbar.from(args.payableHbar, HbarUnit.Hbar));
    }
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
