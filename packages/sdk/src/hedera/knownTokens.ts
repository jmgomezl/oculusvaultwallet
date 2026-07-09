import type { HederaNetwork } from "../types.js";

/** Well-known fungible tokens, verified against the Mirror Node. Kept in a
 * dependency-free module so the browser read path (MirrorClient) can use it
 * without importing @hashgraph/sdk. */
export const USDC_TOKEN_IDS: Partial<Record<HederaNetwork, string>> = {
  mainnet: "0.0.456858", // USD Coin (USDC), 6 decimals
  testnet: "0.0.429274", // USD Coin (USDC), 6 decimals
  // previewnet: none — Circle doesn't mint USDC there (the network resets
  // regularly; verified 2026-07-07 against the previewnet Mirror Node).
  // The Tokens card degrades to add-by-id automatically when no entry exists.
};

export interface KnownToken {
  tokenId: string;
  symbol: string;
  name: string;
}

/**
 * Curated one-tap enable suggestions — the ecosystem's major tokens, so
 * users never have to know a 0.0.x by heart. RULE: every id here was
 * verified against the network's Mirror Node (symbol/name/type) before
 * being added — never extend this list from memory. Verified 2026-07-07.
 */
export const SUGGESTED_TOKENS: Record<HederaNetwork, KnownToken[]> = {
  mainnet: [
    { tokenId: "0.0.456858", symbol: "USDC", name: "USD Coin" },
    { tokenId: "0.0.1055472", symbol: "USDT", name: "Tether USD (hts)" },
    { tokenId: "0.0.731861", symbol: "SAUCE", name: "SaucerSwap" },
    { tokenId: "0.0.834116", symbol: "HBARX", name: "Stader HBARX" },
    { tokenId: "0.0.1456986", symbol: "WHBAR", name: "Wrapped Hbar" },
    { tokenId: "0.0.4794920", symbol: "PACK", name: "HashPack" },
    { tokenId: "0.0.2283230", symbol: "KARATE", name: "Karate Combat" },
    { tokenId: "0.0.3716059", symbol: "DOVU", name: "Dovu" },
  ],
  testnet: [
    { tokenId: "0.0.429274", symbol: "USDC", name: "USD Coin" },
    { tokenId: "0.0.1183558", symbol: "SAUCE", name: "SaucerSwap" },
  ],
  previewnet: [],
};
