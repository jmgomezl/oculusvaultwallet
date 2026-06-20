/**
 * HederaWallet — the high-level, reusable API.
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
import { getNetworkConfig, hashscanAccountUrl } from "./hedera/networks.js";
import { MirrorClient } from "./hedera/mirror.js";
import { sendHbar } from "./hedera/transfer.js";
import type { KeyProvider } from "./keyprovider/KeyProvider.js";
import type {
  Balance,
  HederaNetwork,
  HistoryItem,
  IncomingTransfer,
  SendResult,
  WalletIdentity,
} from "./types.js";

export interface HederaWalletOptions {
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

export class HederaWallet {
  readonly network: HederaNetwork;
  private readonly keyProvider: KeyProvider;
  private readonly namespace: string;
  private readonly mirror: MirrorClient;

  private privateKeyHex: string | null = null;
  private evmAddress: string | null = null;
  private accountId: string | null = null;
  private userId: string | null = null;

  constructor(opts: HederaWalletOptions) {
    this.network = opts.network;
    this.keyProvider = opts.keyProvider;
    this.namespace = opts.storageNamespace ?? "oculusvault:wallet:v1";
    this.mirror = new MirrorClient(
      getNetworkConfig(opts.network),
      opts.fetchImpl,
    );
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

  /** Reveal the raw private key — proof of self-custody. */
  async exportKey(): Promise<string> {
    this.requireUnlocked();
    return this.privateKeyHex!;
  }

  /** Wipe in-memory key material. */
  lock(): void {
    this.privateKeyHex = null;
    this.evmAddress = null;
    this.accountId = null;
    this.userId = null;
  }
}
