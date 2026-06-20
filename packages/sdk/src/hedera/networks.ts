import type { HederaNetwork } from "../types.js";

export interface NetworkConfig {
  network: HederaNetwork;
  mirrorNodeUrl: string;
  /** JSON-RPC relay (Hashio) base, for ethers-style flows. */
  jsonRpcUrl: string;
  /** Hashscan base for building human links. */
  hashscanBase: string;
}

const CONFIGS: Record<HederaNetwork, NetworkConfig> = {
  testnet: {
    network: "testnet",
    mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
    jsonRpcUrl: "https://testnet.hashio.io/api",
    hashscanBase: "https://hashscan.io/testnet",
  },
  mainnet: {
    network: "mainnet",
    mirrorNodeUrl: "https://mainnet-public.mirrornode.hedera.com",
    jsonRpcUrl: "https://mainnet.hashio.io/api",
    hashscanBase: "https://hashscan.io/mainnet",
  },
  previewnet: {
    network: "previewnet",
    mirrorNodeUrl: "https://previewnet.mirrornode.hedera.com",
    jsonRpcUrl: "https://previewnet.hashio.io/api",
    hashscanBase: "https://hashscan.io/previewnet",
  },
};

export function getNetworkConfig(network: HederaNetwork): NetworkConfig {
  const cfg = CONFIGS[network];
  if (!cfg) throw new Error(`Unknown Hedera network: ${network}`);
  return cfg;
}

/** Hashscan link for a transaction id. Hedera tx ids use the form
 * `0.0.x@seconds.nanos`; Hashscan expects `0.0.x-seconds-nanos`. */
export function hashscanTxUrl(
  cfg: NetworkConfig,
  transactionId: string,
): string {
  const normalised = transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
  return `${cfg.hashscanBase}/transaction/${normalised}`;
}

export function hashscanAccountUrl(
  cfg: NetworkConfig,
  accountIdOrEvm: string,
): string {
  return `${cfg.hashscanBase}/account/${accountIdOrEvm}`;
}
