import {
  HederaWallet,
  LocalEncryptedKeyProvider,
  type HederaNetwork,
} from "@oculusvault/sdk";
import { pickStorage } from "./storage.js";

const NETWORK = (import.meta.env.VITE_HEDERA_NETWORK ??
  "testnet") as HederaNetwork;

export function createWallet(): HederaWallet {
  const storage = pickStorage();
  return new HederaWallet({
    network: NETWORK,
    keyProvider: new LocalEncryptedKeyProvider(storage),
  });
}

export const NETWORK_NAME = NETWORK;
