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
import {
  decryptAgentRegistry,
  encryptAgentRegistry,
  type AgentRecord,
} from "./agentRegistry.js";
import type { UserSecret } from "./crypto/encryption.js";
import { fromPrivateKey } from "./crypto/keys.js";
import {
  createAgentAccount,
  freezeAgent as freezeAgentTx,
  retireAgent as retireAgentTx,
  sweepAgent as sweepAgentTx,
  unfreezeAgent as unfreezeAgentTx,
  type CreateAgentAccountResult,
} from "./hedera/agents.js";
import { approveAllowance } from "./hedera/allowances.js";
import { getNetworkConfig, hashscanAccountUrl } from "./hedera/networks.js";
import { createTopic, submitTopicMessage, type CreateTopicResult } from "./hedera/consensus.js";
import { executeContract, type ExecuteContractArgs } from "./hedera/contract.js";
import { MirrorClient, tinybarToHbar } from "./hedera/mirror.js";
import { setStaking } from "./hedera/staking.js";
import { formatTokenAmount, parseTokenAmount } from "./hedera/tokenAmount.js";
import {
  associateToken,
  createFungibleToken,
  sendNft,
  sendToken,
  type CreateTokenResult,
} from "./hedera/tokens.js";
import { sendHbar } from "./hedera/transfer.js";
import type { KeyProvider } from "./keyprovider/KeyProvider.js";
import type { Storage } from "./storage/Storage.js";
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
  TopicMessage,
  TopicRef,
  WalletIdentity,
} from "./types.js";

export interface OculusVaultOptions {
  network: HederaNetwork;
  keyProvider: KeyProvider;
  /** Storage-key prefix; defaults to "oculusvault:wallet:v1". */
  storageNamespace?: string;
  /** Override the fetch used by the Mirror client (tests / custom proxy). */
  fetchImpl?: typeof fetch;
  /** Where the encrypted agent registry lives (Agent Desk). Uses the same
   * Storage contract as the vault — pass a RemoteVaultStorage pointed at the
   * agents slot, or any local Storage. Omit to disable agent management. */
  agentStorage?: Storage;
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

/** An agent as the Desk shows it: the registry record joined with live
 * on-chain facts (balance, real key state). */
export interface AgentView extends AgentRecord {
  balanceHbar: string;
  balanceTinybar: bigint;
  /** Status reconciled against the chain's key structure — "frozen" means
   * the account key is currently the owner's key alone. */
  status: "active" | "frozen" | "retired";
  hashscanUrl: string;
}

/** A display-ready allowance an agent holds on the owner's balance.
 * `tokenId` null = HBAR. Decimal strings are exact (no floats). */
export interface AllowanceView {
  tokenId: string | null;
  symbol: string;
  decimals: number;
  remaining: string;
  granted: string;
  remainingRaw: bigint;
  grantedRaw: bigint;
}

export interface CreateAgentResult {
  agent: AgentRecord;
  /** SHOW ONCE, then drop: the agent's private key never persists anywhere.
   * A lost key is re-issued via freeze → unfreeze with a fresh key. */
  credentials: {
    network: HederaNetwork;
    accountId: string;
    privateKeyHex: string;
    publicKeyHex: string;
  };
  transactionId: string;
  hashscanUrl: string;
  status: string;
}

export class OculusVault {
  private _network: HederaNetwork;
  private readonly keyProvider: KeyProvider;
  private readonly namespace: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly agentStorage?: Storage;
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
    this.agentStorage = opts.agentStorage;
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

  /** Create a fungible HTS token with this wallet as treasury/admin/supply. */
  async createFungibleToken(args: {
    name: string;
    symbol: string;
    decimals: number;
    initialSupply: string;
  }): Promise<CreateTokenResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    return createFungibleToken({
      network: this.network,
      accountId,
      privateKeyHex: this.privateKeyHex!,
      ...args,
    });
  }

  /** Execute a smart contract with ABI-encoded calldata, signed natively. */
  async executeContract(
    args: Omit<ExecuteContractArgs, "network" | "accountId" | "privateKeyHex">,
  ): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    return executeContract({
      network: this.network,
      accountId,
      privateKeyHex: this.privateKeyHex!,
      ...args,
    });
  }

  /** Create an HCS topic owned by this wallet (admin + submit keys). */
  async createTopic(memo?: string): Promise<CreateTopicResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    return createTopic({
      network: this.network,
      accountId,
      privateKeyHex: this.privateKeyHex!,
      memo,
    });
  }

  /** Stamp a message onto one of this wallet's topics. */
  async submitTopicMessage(topicId: string, message: string): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    return submitTopicMessage({
      network: this.network,
      accountId,
      privateKeyHex: this.privateKeyHex!,
      topicId,
      message,
    });
  }

  /** Topics this wallet created ([] until the account exists). */
  async getTopics(): Promise<TopicRef[]> {
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) return [];
    return this.mirror.getCreatedTopics(accountId);
  }

  /** Latest messages on a topic (public data — any topic id works). */
  async getTopicMessages(topicId: string, limit = 25): Promise<TopicMessage[]> {
    return this.mirror.getTopicMessages(topicId, limit);
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

  // --- Agent Desk (Tier 1: petty-cash agent accounts) ---

  private agentStorageKey(): string {
    if (!this.userId) throw new Error("Wallet has no user context");
    return `oculusvault:agents:v1:${this.userId}`;
  }

  private requireAgentStorage(): Storage {
    if (!this.agentStorage) {
      throw new Error("Agent Desk is not enabled — no agent storage configured");
    }
    return this.agentStorage;
  }

  private async loadAgents(): Promise<AgentRecord[]> {
    const raw = await this.requireAgentStorage().getItem(this.agentStorageKey());
    if (!raw) return [];
    this.requireUnlocked();
    return decryptAgentRegistry(JSON.parse(raw), this.privateKeyHex!);
  }

  private async saveAgents(records: AgentRecord[]): Promise<void> {
    this.requireUnlocked();
    const encrypted = encryptAgentRegistry(records, this.privateKeyHex!);
    await this.requireAgentStorage().setItem(
      this.agentStorageKey(),
      JSON.stringify(encrypted),
    );
  }

  private async updateAgentRecord(
    accountId: string,
    patch: Partial<AgentRecord>,
  ): Promise<void> {
    const records = await this.loadAgents();
    const idx = records.findIndex(
      (r) => r.accountId === accountId && r.network === this.network,
    );
    if (idx < 0) return; // acting on an unregistered agent is fine — chain is truth
    records[idx] = { ...records[idx]!, ...patch };
    await this.saveAgents(records);
  }

  /** Whether this wallet instance can manage agents. */
  get agentsEnabled(): boolean {
    return this.agentStorage != null;
  }

  /** Agents on the current network, joined with live on-chain state. */
  async listAgents(): Promise<AgentView[]> {
    const records = (await this.loadAgents()).filter(
      (r) => r.network === this.network,
    );
    return Promise.all(
      records.map(async (r) => {
        let status: AgentView["status"] = r.retiredAt
          ? "retired"
          : r.frozen
            ? "frozen"
            : "active";
        let balanceTinybar = 0n;
        if (!r.retiredAt) {
          // The chain is the source of truth; the stored flag is a hint.
          try {
            const flags = await this.mirror.getAccountFlags(r.accountId);
            if (flags) {
              balanceTinybar = flags.balanceTinybar;
              status = flags.deleted
                ? "retired"
                : flags.keyIsComplex
                  ? "active"
                  : "frozen";
            }
          } catch {
            // Mirror hiccups must not hide the agent — fall back to the hint.
          }
        }
        return {
          ...r,
          balanceTinybar,
          balanceHbar: tinybarToHbar(balanceTinybar),
          status,
          hashscanUrl: this.accountUrl(r.accountId),
        } satisfies AgentView;
      }),
    );
  }

  /**
   * Create a petty-cash agent account (1-of-2 KeyList [owner, agent]) funded
   * from this wallet, and register it. The returned credentials are shown
   * ONCE and never stored — hand them to the agent runtime.
   */
  async createAgent(
    name: string,
    initialHbar: string | number,
  ): Promise<CreateAgentResult> {
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > 40) throw new Error("Agent name: 1–40 characters");
    this.requireUnlocked();
    this.requireAgentStorage();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) {
      throw new Error(
        "This wallet has no on-ledger account yet — receive HBAR first to auto-create it",
      );
    }
    const created: CreateAgentAccountResult = await createAgentAccount({
      network: this.network,
      ownerAccountId: accountId,
      ownerPrivateKeyHex: this.privateKeyHex!,
      initialHbar,
      memo: `oculusvault agent: ${trimmed}`,
    });
    const record: AgentRecord = {
      accountId: created.accountId,
      name: trimmed,
      network: this.network,
      agentPublicKeyHex: created.agentPublicKeyHex,
      frozen: false,
      createdAt: new Date().toISOString(),
    };
    const records = await this.loadAgents();
    records.push(record);
    await this.saveAgents(records);
    return {
      agent: record,
      credentials: {
        network: this.network,
        accountId: created.accountId,
        privateKeyHex: created.agentPrivateKeyHex,
        publicKeyHex: created.agentPublicKeyHex,
      },
      transactionId: created.transactionId,
      hashscanUrl: created.hashscanUrl,
      status: created.status,
    };
  }

  /** Top up an agent's petty cash from this wallet. */
  async fundAgent(agentAccountId: string, amountHbar: string | number): Promise<SendResult> {
    return this.send(agentAccountId, amountHbar, "oculusvault agent refill");
  }

  /** Freeze: rotate the agent's key out — it stops spending instantly. */
  async freezeAgent(agentAccountId: string): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) throw new Error("Wallet has no on-ledger account");
    const result = await freezeAgentTx({
      network: this.network,
      ownerAccountId: accountId,
      ownerPrivateKeyHex: this.privateKeyHex!,
      agentAccountId,
    });
    await this.updateAgentRecord(agentAccountId, { frozen: true });
    return result;
  }

  /** Unfreeze: restore the 1-of-2 KeyList so the agent's key works again. */
  async unfreezeAgent(agentAccountId: string): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) throw new Error("Wallet has no on-ledger account");
    const records = await this.loadAgents();
    const record = records.find(
      (r) => r.accountId === agentAccountId && r.network === this.network,
    );
    if (!record) throw new Error("Unknown agent — it isn't in your registry");
    const result = await unfreezeAgentTx({
      network: this.network,
      ownerAccountId: accountId,
      ownerPrivateKeyHex: this.privateKeyHex!,
      agentAccountId,
      agentPublicKeyHex: record.agentPublicKeyHex,
    });
    await this.updateAgentRecord(agentAccountId, { frozen: false });
    return result;
  }

  /** Sweep the agent's ENTIRE balance back to this wallet (owner-signed). */
  async sweepAgent(agentAccountId: string): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) throw new Error("Wallet has no on-ledger account");
    const flags = await this.mirror.getAccountFlags(agentAccountId);
    if (!flags || flags.balanceTinybar <= 0n) {
      throw new Error("Nothing to sweep — the agent's balance is 0 ℏ");
    }
    return sweepAgentTx({
      network: this.network,
      ownerAccountId: accountId,
      ownerPrivateKeyHex: this.privateKeyHex!,
      agentAccountId,
      amountTinybar: flags.balanceTinybar,
      memo: "oculusvault agent sweep",
    });
  }

  /** Retire: delete the agent account, sweeping any remainder home. */
  async retireAgent(agentAccountId: string): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) throw new Error("Wallet has no on-ledger account");
    const result = await retireAgentTx({
      network: this.network,
      ownerAccountId: accountId,
      ownerPrivateKeyHex: this.privateKeyHex!,
      agentAccountId,
    });
    await this.updateAgentRecord(agentAccountId, {
      retiredAt: new Date().toISOString(),
      frozen: false,
    });
    return result;
  }

  /** Recent activity of one agent account (public mirror data). */
  async getAgentHistory(agentAccountId: string): Promise<HistoryItem[]> {
    return this.mirror.getHistory(agentAccountId, { limit: 10 });
  }

  /**
   * Tier 2: grant an agent a spending cap on THIS wallet's balance
   * (HIP-336). `asset` is "hbar" or an HTS token id; `amount` is a human
   * decimal string. The cap replaces any existing one for that agent+asset.
   */
  async grantAgentAllowance(
    agentAccountId: string,
    asset: "hbar" | string,
    amount: string | number,
  ): Promise<SendResult> {
    this.requireUnlocked();
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) throw new Error("Wallet has no on-ledger account");
    const base = {
      network: this.network,
      ownerAccountId: accountId,
      ownerPrivateKeyHex: this.privateKeyHex!,
      spenderAccountId: agentAccountId,
    };
    if (asset === "hbar") {
      return approveAllowance({ ...base, amountHbar: amount });
    }
    const info = await this.mirror.getTokenInfo(asset);
    return approveAllowance({
      ...base,
      token: { tokenId: asset, amountRaw: parseTokenAmount(amount, info.decimals) },
    });
  }

  /** Revoke = approve 0. Takes effect immediately, network-enforced. */
  async revokeAgentAllowance(
    agentAccountId: string,
    asset: "hbar" | string,
  ): Promise<SendResult> {
    return this.grantAgentAllowance(agentAccountId, asset, "0");
  }

  /** What one agent may still draw from this wallet, display-ready. */
  async getAgentAllowances(agentAccountId: string): Promise<AllowanceView[]> {
    const accountId = this.accountId ?? (await this.refreshAccountId());
    if (!accountId) return [];
    const rows = await this.mirror.getAllowances(accountId, agentAccountId);
    return Promise.all(
      rows.map(async (r) => {
        if (r.tokenId == null) {
          return {
            tokenId: null,
            symbol: "ℏ",
            decimals: 8,
            remaining: tinybarToHbar(r.remainingRaw),
            granted: tinybarToHbar(r.grantedRaw),
            remainingRaw: r.remainingRaw,
            grantedRaw: r.grantedRaw,
          } satisfies AllowanceView;
        }
        let symbol = r.tokenId;
        let decimals = 0;
        try {
          const info = await this.mirror.getTokenInfo(r.tokenId);
          symbol = info.symbol || r.tokenId;
          decimals = info.decimals;
        } catch {
          // Metadata lookup failing must not hide the allowance itself.
        }
        return {
          tokenId: r.tokenId,
          symbol,
          decimals,
          remaining: formatTokenAmount(r.remainingRaw, decimals),
          granted: formatTokenAmount(r.grantedRaw, decimals),
          remainingRaw: r.remainingRaw,
          grantedRaw: r.grantedRaw,
        } satisfies AllowanceView;
      }),
    );
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
