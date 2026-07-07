/**
 * OculusVault — the high-level, reusable API.
 *
 * Lifecycle:
 *   1. construct with a network + KeyProvider (+ optional Storage).
 *   2. createOrRecoverWallet({ userId, secret }) to unlock — keeps the
 *      decrypted key in memory only.
 *   3. getBalance / getHistory / send / onIncoming / exportKey.
 *   4. lock() to wipe in-memory key material.
 *
 * `userId` is the VERIFIED Telegram user id (from the backend's initData
 * check). It is used ONLY to namespace storage — never as key material.
 */
import type { UserSecret } from "./crypto/encryption.js";
import { fromPrivateKey } from "./crypto/keys.js";
import { getNetworkConfig, hashscanAccountUrl } from "./hedera/networks.js";
import { MirrorClient } from "./hedera/mirror.js";
import { setStaking } from "./hedera/staking.js";
import { parseTokenAmount } from "./hedera/tokenAmount.js";
import { associateToken, sendNft, sendToken } from "./hedera/tokens.js";
import { sendHbar } from "./hedera/transfer.js";
import type { KeyProvider } from "./keyprovider/KeyProvider.js";
import type {
  Balance,
  HederaNetwork,
  HistoryItem,
  IncomingTransfer,
  NetworkNode,
  NftItem,
  SendResult,
  StakingInfo,
  TokenBalance,
  TokenInfo,
  WalletIdentity,
} from "./types.js";

export interface OculusVaultOptions {
  network: HederaNetwork;
  keyProvider: KeyProvider;
  /** Storage-key prefix; defaults to "oculusvault:wallet:v1". */
  storageNamespace?: string;
  /** Override the fetch used by the Mirror client (tests / custom proxy). */
  fetchImpl?: typeof fetch;
}

export interface UnlockArgs {
  /** Verified Telegram user id. */
  userId: string | number;
  /** Password or passkey-PRF secret used to encrypt/decrypt the key. */
  secret: UserSecret;
  /** When true (default), create a wallet if none exists; otherwise require
   * an existing one. */
  createIfMissing?: boolean;
}

export interface OnIncomingOptions {
  intervalMs?: number;
  /** Fire for transfers already present at subscribe time. Default false —
   * only new credits after subscribe fire (including the account-creating
   * credit for a brand-new wallet). */
  replayExisting?: boolean;
}

export class OculusVault {
  private _network: HederaNetwork;
  private readonly keyProvider: KeyProvider;
  private readonly namespace: string;
  private readonly fetchImpl?: typeof fetch;
  private mirror: MirrorClient;

  private privateKeyHex: string | null = null;
  private evmAddress: string | null = null;
  private accountId: string | null = null;
  private userId: string | null = null;

  constructor(opts: OculusVaultOptions) {
    this._network = opts.network;
    this.keyProvider = opts.keyProvider;
    this.namespace = opts.storageNamespace ?? "oculusvault:wallet:v1";
    this.fetchImpl = opts.fetchImpl;
    this.mirror = new MirrorClient(
      getNetworkConfig(opts.network),
      opts.fetchImpl,
    );
  }

  get network(): HederaNetwork {
    return this._network;
  }

  /**
   * Switch the wallet to another Hedera network. The SAME key (and therefore
   * the same 0x address) is valid on every network — only the on-ledger
   * account id differs, so this is instant: no re-unlock needed. The account
   * id is reset and re-resolved lazily (call refreshAccountId() or any read).
   * Re-subscribe any onIncoming() watchers after switching.
   */
  switchNetwork(network: HederaNetwork): void {
    if (network === this._network) return;
    this._network = network;
    this.mirror = new MirrorClient(getNetworkConfig(network), this.fetchImpl);
    this.accountId = null; // per-network; re-resolved on next read
  }

  private storageKey(userId: string | number): string {
    return `${this.namespace}:${userId}`;
  }

  /** Whether a wallet already exists for this user (drives create-vs-unlock UI). */
  async hasWallet(userId: string | number): Promise<boolean> {
    return this.keyProvider.hasWallet(this.storageKey(userId));
  }

  private requireUnlocked(): void {
    if (!this.privateKeyHex || !this.evmAddress) {
      throw new Error("Wallet is locked; call createOrRecoverWallet() first");
    }
  }

  /** Provision a new wallet or recover the existing one, then unlock it. */
  async createOrRecoverWallet(args: UnlockArgs): Promise<WalletIdentity> {
    const storageKey = this.storageKey(args.userId);
    const exists = await this.keyProvider.hasWallet(storageKey);
    const material =
      exists || args.createIfMissing === false
        ? await this.keyProvider.recover({ storageKey, secret: args.secret })
        : await this.keyProvider.provision({ storageKey, secret: args.secret });

    if (!material.privateKeyHex) {
      throw new Error(
        "KeyProvider returned no private key; remote signers are not supported by this build",
      );
    }
    this.privateKeyHex = material.privateKeyHex;
    this.evmAddress = material.evmAddress;
    this.userId = String(args.userId);

    // Resolve the on-ledger account id (null until first inbound HBAR).
    await this.refreshAccountId();
    return this.getIdentity();
  }

  /** Public address of the stored record without needing the secret — lets a
   * recovery UI warn before replacing a different wallet. */
  async storedAddress(userId: string | number): Promise<string | null> {
    if (!this.keyProvider.getStoredAddress) return null;
    return this.keyProvider.getStoredAddress(this.storageKey(userId));
  }

  /**
   * Forgot-password recovery / import: restore the wallet from a backed-up
   * private key, encrypting it with a NEW secret and replacing the stored
   * record, then unlock. Compare storedAddress() first to warn the user if
   * the supplied key belongs to a different wallet than the stored one.
   */
  async importWallet(args: {
    userId: string | number;
    privateKeyHex: string;
    secret: UserSecret;
  }): Promise<WalletIdentity> {
    if (!this.keyProvider.importPrivateKey) {
      throw new Error("This key provider does not support key import");
    }
    const material = await this.keyProvider.importPrivateKey({
      storageKey: this.storageKey(args.userId),
      privateKeyHex: args.privateKeyHex,
      secret: args.secret,
    });
    if (!material.privateKeyHex) {
      throw new Error("KeyProvider returned no private key");
    }
    this.privateKeyHex = material.privateKeyHex;
    this.evmAddress = material.evmAddress;
    this.userId = String(args.userId);
    await this.refreshAccountId();
    return this.getIdentity();
  }

  /**
   * Unlock directly with a raw private key (e.g. a key restored from a
   * short-lived session cache, or an imported key). Does NOT touch storage.
   * The identity is derived from the key itself.
   */
  async unlockWithKey(
    privateKeyHex: string,
    userId?: string | number,
  ): Promise<WalletIdentity> {
    const key = fromPrivateKey(privateKeyHex);
    this.privateKeyHex = key.privateKeyHex;
    this.evmAddress = key.evmAddress;
    if (userId != null) this.userId = String(userId);
    await this.refreshAccountId();
    return this.getIdentity();
  }

  /** Re-check whether the account has been auto-created on-ledger. */
  async refreshAccountId(): Promise<string | null> {
    if (!this.evmAddress) return null;
    const acct = await this.mirror.resolveAccount(this.evmAddress);
    this.accountId = acct?.accountId ?? null;
    return this.accountId;
  }

  getIdentity(): WalletIdentity {
    this.requireUnlocked();
    return { evmAddress: this.evmAddress!, hederaAccountId: this.accountId };
  }

  /** Hashscan account page for the current (or a given) account. */
  accountUrl(idOrEvm?: string): string {
    const target = idOrEvm ?? this.accountId ?? this.evmAddress;
    if (!target) throw new Error("No account to link");
    return hashscanAccountUrl(getNetworkConfig(this.network), target);
  }

  async getBalance(idOrEvm?: string): Promise<Balance> {
    const target = idOrEvm ?? this.accountId ?? this.evmAddress;
    if (!target) this.requireUnlocked();
    return this.mirror.getBalance(target!);
  }

  async getHistory(idOrEvm?: string): Promise<HistoryItem[]> {
    let accountId = idOrEvm ?? this.accountId;
    if (!accountId) {
      // Maybe the account got created since unlock.
      accountId = await this.refreshAccountId();
    }
    if (!accountId) return []; // not created yet → no history
    return this.mirror.getHistory(accountId);
  }

  async send(
    to: string,
    amountHbar: string | number,
    memo?: string,
  ): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    return sendHbar({
      network: this.network,
      senderAccountId: accountId,
      senderPrivateKeyHex: this.privateKeyHex!,
      to,
      amountHbar,
      memo,
    });
  }

  /** Fungible HTS tokens this wallet holds ([] until the account exists). */
  async getTokenBalances(): Promise<TokenBalance[]> {
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) return [];
    return this.mirror.getTokenBalances(accountId);
  }

  /** Token metadata lookup (name/symbol/decimals) — drives "add token" UIs. */
  async getTokenInfo(tokenId: string): Promise<TokenInfo> {
    return this.mirror.getTokenInfo(tokenId);
  }

  /**
   * Send an HTS fungible token. `amount` is a human decimal string ("1.5");
   * it is converted exactly using the token's on-ledger decimals — amounts
   * with more precision than the token supports are rejected, not truncated.
   */
  async sendToken(
    tokenId: string,
    to: string,
    amount: string | number,
    memo?: string,
  ): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    const info = await this.mirror.getTokenInfo(tokenId);
    return sendToken({
      network: this.network,
      senderAccountId: accountId,
      senderPrivateKeyHex: this.privateKeyHex!,
      to,
      tokenId,
      amountRaw: parseTokenAmount(amount, info.decimals),
      memo,
    });
  }

  /** Transfer one NFT serial this wallet owns. */
  async sendNft(
    tokenId: string,
    serialNumber: number,
    to: string,
    memo?: string,
  ): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    return sendNft({
      network: this.network,
      senderAccountId: accountId,
      senderPrivateKeyHex: this.privateKeyHex!,
      to,
      tokenId,
      serialNumber,
      memo,
    });
  }

  /** Opt in to a token so this wallet can receive it (small HBAR fee). */
  async associateToken(tokenId: string): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    return associateToken({
      network: this.network,
      accountId,
      privateKeyHex: this.privateKeyHex!,
      tokenId,
    });
  }

  /** NFTs this wallet holds ([] until the account exists). */
  async getNfts(): Promise<NftItem[]> {
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) return [];
    return this.mirror.getNfts(accountId);
  }

  /** Native-staking state, or null before the account exists on-ledger. */
  async getStakingInfo(): Promise<StakingInfo | null> {
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) return null;
    return this.mirror.getStakingInfo(accountId);
  }

  /** Consensus nodes available to stake to on the current network. */
  async getNetworkNodes(): Promise<NetworkNode[]> {
    return this.mirror.getNetworkNodes();
  }

  /** Stake the account's balance to a node (nothing moves, no lockup). */
  async stakeToNode(nodeId: number): Promise<SendResult> {
    return this.updateStaking(nodeId);
  }

  /** Stop staking. */
  async stopStaking(): Promise<SendResult> {
    return this.updateStaking(null);
  }

  private async updateStaking(nodeId: number | null): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    return setStaking({
      network: this.network,
      accountId,
      privateKeyHex: this.privateKeyHex!,
      nodeId,
    });
  }

  /**
   * Poll the Mirror Node for inbound HBAR and invoke `callback` for each new
   * credit. Returns an unsubscribe function.
   */
  onIncoming(
    callback: (transfer: IncomingTransfer) => void,
    options: OnIncomingOptions = {},
  ): () => void {
    const intervalMs = options.intervalMs ?? 5000;
    let stopped = false;
    let initialized = options.replayExisting ?? false;
    let cursor: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const accountId = this.accountId ?? (await this.refreshAccountId());
        if (accountId) {
          if (!initialized) {
            // Seed the cursor to the latest existing tx so we don't replay
            // history — but still catch the next credit.
            const latest = await this.mirror.getHistory(accountId, {
              limit: 1,
              order: "desc",
            });
            cursor = latest[0]?.consensusTimestamp;
            initialized = true;
          } else {
            const items = await this.mirror.getHistory(accountId, {
              order: "asc",
              timestampGt: cursor,
              limit: 25,
            });
            for (const item of items) {
              cursor = item.consensusTimestamp;
              if (item.direction === "in") {
                callback(item as IncomingTransfer);
              }
            }
          }
        }
      } catch {
        // Swallow transient Mirror errors; next tick retries.
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }

  /** Reveal the raw private key from memory — proof of self-custody. Trusts
   * the current unlocked session; use exportKeyWithSecret() to require the
   * password again before revealing. */
  async exportKey(): Promise<string> {
    this.requireUnlocked();
    return this.privateKeyHex!;
  }

  /**
   * Reveal the raw private key ONLY after re-verifying the user's secret —
   * it re-derives and decrypts the stored ciphertext, so a wrong password
   * throws (Poly1305 auth failure) even though the key is already unlocked in
   * memory. Use this to gate the "export key" action against shoulder-surfing
   * or a walked-away session.
   */
  async exportKeyWithSecret(secret: UserSecret): Promise<string> {
    this.requireUnlocked();
    if (!this.userId) throw new Error("Wallet has no user context");
    if (!this.keyProvider.exportPrivateKey) {
      throw new Error("This key provider can’t re-verify the password");
    }
    const key = await this.keyProvider.exportPrivateKey({
      storageKey: this.storageKey(this.userId),
      secret,
    });
    // Defense-in-depth: the re-decrypted key must match the unlocked one.
    if (key.toLowerCase() !== this.privateKeyHex!.toLowerCase()) {
      throw new Error("Re-verified key does not match the unlocked wallet");
    }
    return key;
  }

  /** Wipe in-memory key material. */
  lock(): void {
    this.privateKeyHex = null;
    this.evmAddress = null;
    this.accountId = null;
    this.userId = null;
  }
}
