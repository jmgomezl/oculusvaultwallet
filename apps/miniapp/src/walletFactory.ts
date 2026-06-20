import {
  OculusVault,
  LocalEncryptedKeyProvider,
  type HederaNetwork,
} from "@oculusvault/sdk";
import { pickStorage } from "./storage.js";

const NETWORK = (import.meta.env.VITE_HEDERA_NETWORK ??
  "testnet") as HederaNetwork;

export function createWallet(): OculusVault {
  const storage = pickStorage();
  return new OculusVault({
    network: NETWORK,
    keyProvider: new LocalEncryptedKeyProvider(storage),
  });
}

export const NETWORK_NAME = NETWORK;
