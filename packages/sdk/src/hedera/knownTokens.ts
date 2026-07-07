import type { HederaNetwork } from "../types.js";

/** Well-known fungible tokens, verified against the Mirror Node. Kept in a
 * dependency-free module so the browser read path (MirrorClient) can use it
 * without importing @hashgraph/sdk. */
export const USDC_TOKEN_IDS: Partial<Record<HederaNetwork, string>> = {
  mainnet: "0.0.456858", // USD Coin (USDC), 6 decimals
  testnet: "0.0.429274", // USD Coin (USDC), 6 decimals
};
