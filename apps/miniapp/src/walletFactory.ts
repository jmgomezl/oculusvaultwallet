import {
  OculusVault,
  LocalEncryptedKeyProvider,
  RemoteVaultStorage,
  type HederaNetwork,
  type Storage,
} from "@oculusvault/sdk";
import { pickStorage } from "./storage.js";
import { API_BASE, getToken } from "./api.js";

/** Default network for new visitors; the in-app switcher overrides it. */
export const DEFAULT_NETWORK = (import.meta.env.VITE_HEDERA_NETWORK ??
  "testnet") as HederaNetwork;

// Use the shared cross-app vault by default (one wallet across all apps that
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

/** The vault record is network-independent (same key everywhere), so one
 * wallet instance serves every network via switchNetwork(). */
export function createWallet(network: HederaNetwork = DEFAULT_NETWORK): OculusVault {
  return new OculusVault({
    network,
    keyProvider: new LocalEncryptedKeyProvider(makeStorage()),
  });
}
