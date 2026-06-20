import {
  OculusVault,
  LocalEncryptedKeyProvider,
  RemoteVaultStorage,
  type HederaNetwork,
  type Storage,
} from "@oculusvault/sdk";
import { pickStorage } from "./storage.js";
import { API_BASE, getToken } from "./api.js";

const NETWORK = (import.meta.env.VITE_HEDERA_NETWORK ??
  "testnet") as HederaNetwork;

// Use the shared, cross-app vault by default (one wallet across all apps that
// share this backend). Opt out with VITE_USE_SHARED_VAULT=false to keep a
// per-app wallet in Telegram CloudStorage.
const USE_SHARED_VAULT =
  (import.meta.env.VITE_USE_SHARED_VAULT ?? "true") !== "false";

function makeStorage(): Storage {
  if (USE_SHARED_VAULT && API_BASE) {
    return new RemoteVaultStorage({ apiBase: API_BASE, getToken });
  }
  return pickStorage();
}

export function createWallet(): OculusVault {
  return new OculusVault({
    network: NETWORK,
    keyProvider: new LocalEncryptedKeyProvider(makeStorage()),
  });
}

export const NETWORK_NAME = NETWORK;
