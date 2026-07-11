/**
 * Hedera Mirror Node REST client (read path): account resolution, balance,
 * transfer history, and incoming-transfer polling. No SDK/gRPC needed for
 * reads — plain HTTP works in the browser and Node alike.
 */
import type {
  Balance,
  HistoryItem,
  NetworkNode,
  NftItem,
  StakingInfo,
  TokenBalance,
  TokenInfo,
  TopicMessage,
  TopicRef,
} from "../types.js";
import { base64urlToBytes } from "../crypto/encoding.js";
import { USDC_TOKEN_IDS } from "./knownTokens.js";
import { formatTokenAmount } from "./tokenAmount.js";
import { hashscanTxUrl, type NetworkConfig } from "./networks.js";

const TINYBAR_PER_HBAR = 100_000_000n;

/** ipfs://CID[/path] → a public https gateway URL; https URLs pass through. */
export function ipfsToHttps(uri: string): string {
  return uri.replace(/^ipfs:\/\//i, "https://ipfs.io/ipfs/");
}

export function tinybarToHbar(tinybar: bigint): string {
  const neg = tinybar < 0n;
  const abs = neg ? -tinybar : tinybar;
  const whole = abs / TINYBAR_PER_HBAR;
  const frac = (abs % TINYBAR_PER_HBAR).toString().padStart(8, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export interface ResolvedAccount {
  accountId: string;
  evmAddress: string | null;
  balanceTinybar: bigint;
}

/** One HIP-336 allowance row: what a spender may still draw from an owner.
 * `tokenId` null = HBAR (amounts in tinybar); otherwise amounts are in the
 * token's smallest units. */
export interface AllowanceInfo {
  spender: string;
  tokenId: string | null;
  /** Live remaining cap (decremented by the mirror as it's spent). */
  remainingRaw: bigint;
  /** The originally approved cap. */
  grantedRaw: bigint;
}

/** A pending scheduled transaction awaiting signatures, as the mirror
 * reports it. `transactionBody` is the base64 SchedulableTransactionBody —
 * decode with describeScheduledBody() to see what it would do. */
export interface PendingSchedule {
  scheduleId: string;
  creatorAccountId: string;
  payerAccountId: string;
  memo?: string;
  transactionBody: string;
  createdAt: string;
  expiresAt: string;
}

/** On-chain facts about an account that drive agent status displays. */
export interface AccountFlags {
  accountId: string;
  deleted: boolean;
  /** True when the account key is a complex key (KeyList/threshold) — the
   * mirror reports those as `_type: "ProtobufEncoded"`. An active 1-of-2
   * agent account is complex; a frozen one (rotated to the owner's key
   * alone) is a simple key. */
  keyIsComplex: boolean;
  /** Hex of the key material as the mirror reports it. */
  keyHex: string | null;
  balanceTinybar: bigint;
}

export class MirrorClient {
  private readonly cfg: NetworkConfig;
  private readonly fetchImpl: typeof fetch;
  private rateCache: { usdPerHbar: number; at: number } | null = null;
  /** Token metadata is immutable enough to cache for the client's lifetime
   * (a new MirrorClient is built per network switch). */
  private tokenInfoCache = new Map<string, TokenInfo>();

  constructor(cfg: NetworkConfig, fetchImpl?: typeof fetch) {
    this.cfg = cfg;
    // Wrap so native fetch keeps its binding to the global object (calling a
    // stored reference to window.fetch directly throws "Illegal invocation").
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.cfg.mirrorNodeUrl}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(
        `Mirror Node ${res.status} for ${path}${body ? `: ${body}` : ""}`,
      ) as Error & { status?: number };
      err.status = res.status;
      throw err;
    }
    return (await res.json()) as T;
  }

  /** Resolve an account by 0.0.x id or 0x EVM address. Returns null when the
   * account does not exist yet (e.g. before its first inbound HBAR). */
  async resolveAccount(idOrEvm: string): Promise<ResolvedAccount | null> {
    try {
      const data = await this.get<any>(
        `/api/v1/accounts/${encodeURIComponent(idOrEvm)}?limit=1`,
      );
      return {
        accountId: data.account,
        evmAddress: data.evm_address ?? null,
        balanceTinybar: BigInt(data.balance?.balance ?? 0),
      };
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /**
   * HIP-336 allowances an owner has granted, optionally filtered to one
   * spender. `remainingRaw` is live — the mirror decrements it as the
   * spender draws down; `grantedRaw` is the original cap. HBAR rows have no
   * tokenId and are denominated in tinybar; token rows use the token's
   * smallest units. Fully-consumed allowances (remaining 0) still appear
   * until re-approved; revoked ones (approve 0) disappear.
   */
  async getAllowances(
    ownerAccountId: string,
    spenderAccountId?: string,
  ): Promise<AllowanceInfo[]> {
    const owner = encodeURIComponent(ownerAccountId);
    const filter = spenderAccountId
      ? `?spender.id=${encodeURIComponent(spenderAccountId)}&limit=100`
      : "?limit=100";
    const [crypto, tokens] = await Promise.all([
      this.get<any>(`/api/v1/accounts/${owner}/allowances/crypto${filter}`),
      this.get<any>(`/api/v1/accounts/${owner}/allowances/tokens${filter}`),
    ]);
    const rows: AllowanceInfo[] = [];
    for (const a of crypto.allowances ?? []) {
      rows.push({
        spender: a.spender,
        tokenId: null,
        remainingRaw: BigInt(a.amount ?? 0),
        grantedRaw: BigInt(a.amount_granted ?? 0),
      });
    }
    for (const a of tokens.allowances ?? []) {
      rows.push({
        spender: a.spender,
        tokenId: a.token_id,
        remainingRaw: BigInt(a.amount ?? 0),
        grantedRaw: BigInt(a.amount_granted ?? 0),
      });
    }
    return rows;
  }

  /**
   * Scheduled transactions CREATED BY an account that are still pending
   * (not executed, not deleted, not past expiry). This is the discovery
   * path for the Agent Desk approvals inbox: agents create schedules; the
   * owner's wallet lists and co-signs them. Schedules without an explicit
   * expiration_time expire 30 minutes after creation — we filter those out
   * client-side since the mirror keeps returning them.
   */
  async getPendingSchedules(creatorAccountId: string): Promise<PendingSchedule[]> {
    const params = new URLSearchParams({
      "account.id": creatorAccountId,
      order: "desc",
      limit: "25",
    });
    const data = await this.get<any>(`/api/v1/schedules?${params}`);
    const now = Date.now() / 1000;
    const out: PendingSchedule[] = [];
    for (const s of data.schedules ?? []) {
      if (s.executed_timestamp != null || s.deleted) continue;
      const created = Number(s.consensus_timestamp ?? 0);
      const expiresAtSec =
        s.expiration_time != null ? Number(s.expiration_time) : created + 1800;
      if (expiresAtSec <= now) continue;
      out.push({
        scheduleId: s.schedule_id,
        creatorAccountId: s.creator_account_id,
        payerAccountId: s.payer_account_id,
        memo: s.memo || undefined,
        transactionBody: s.transaction_body,
        createdAt: new Date(Math.floor(created * 1000)).toISOString(),
        expiresAt: new Date(Math.floor(expiresAtSec * 1000)).toISOString(),
      });
    }
    return out;
  }

  /** Key structure + deleted flag + balance of an account (null when it
   * doesn't exist). Deleted accounts still resolve on the mirror. */
  async getAccountFlags(accountId: string): Promise<AccountFlags | null> {
    try {
      const data = await this.get<any>(
        `/api/v1/accounts/${encodeURIComponent(accountId)}?limit=1`,
      );
      return {
        accountId: data.account,
        deleted: Boolean(data.deleted),
        keyIsComplex: data.key?._type === "ProtobufEncoded",
        keyHex: data.key?.key ?? null,
        balanceTinybar: BigInt(data.balance?.balance ?? 0),
      };
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  /**
   * USD per HBAR from the network's own exchange-rate file
   * (/api/v1/network/exchangerate: cents per hbar_equivalent). Cached for
   * 5 minutes; returns null on any failure — an estimate must never break
   * the balance path.
   */
  async getUsdPerHbar(): Promise<number | null> {
    const now = Date.now();
    if (this.rateCache && now - this.rateCache.at < 300_000) {
      return this.rateCache.usdPerHbar;
    }
    try {
      const data = await this.get<any>("/api/v1/network/exchangerate");
      const rate = data?.current_rate;
      if (!rate?.hbar_equivalent || !rate?.cent_equivalent) return null;
      const usdPerHbar = rate.cent_equivalent / rate.hbar_equivalent / 100;
      this.rateCache = { usdPerHbar, at: now };
      return usdPerHbar;
    } catch {
      return null;
    }
  }

  async getBalance(idOrEvm: string): Promise<Balance> {
    const [acct, rate] = await Promise.all([
      this.resolveAccount(idOrEvm),
      this.getUsdPerHbar(),
    ]);
    const tinybar = acct?.balanceTinybar ?? 0n;
    const hbar = tinybarToHbar(tinybar);
    return {
      hbar,
      tinybar,
      usdEstimate: rate == null ? null : Number(hbar) * rate,
    };
  }

  /** Native-staking state of an account (node, pending reward). */
  async getStakingInfo(accountId: string): Promise<StakingInfo> {
    const data = await this.get<any>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}?limit=1`,
    );
    const pending = BigInt(data.pending_reward ?? 0);
    return {
      stakedNodeId: data.staked_node_id ?? null,
      pendingRewardTinybar: pending,
      pendingRewardHbar: tinybarToHbar(pending),
      declineReward: Boolean(data.decline_reward),
    };
  }

  /** Consensus nodes available to stake to. */
  async getNetworkNodes(): Promise<NetworkNode[]> {
    const data = await this.get<any>("/api/v1/network/nodes?limit=100");
    return (data.nodes ?? []).map((n: any) => ({
      nodeId: Number(n.node_id),
      description: String(n.description ?? `Node ${n.node_id}`),
    }));
  }

  /** Public metadata of an HTS token (name/symbol/decimals), cached. */
  async getTokenInfo(tokenId: string): Promise<TokenInfo> {
    const cached = this.tokenInfoCache.get(tokenId);
    if (cached) return cached;
    const data = await this.get<any>(
      `/api/v1/tokens/${encodeURIComponent(tokenId)}`,
    );
    const info: TokenInfo = {
      tokenId: data.token_id,
      name: data.name ?? "",
      symbol: data.symbol ?? "",
      decimals: Number(data.decimals ?? 0),
      type: data.type ?? "",
    };
    this.tokenInfoCache.set(tokenId, info);
    return info;
  }

  /**
   * Fungible HTS tokens the account is associated with, joined with their
   * metadata. NFTs are filtered out — this wallet surfaces fungibles only.
   */
  async getTokenBalances(accountId: string): Promise<TokenBalance[]> {
    const data = await this.get<any>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/tokens?limit=100`,
    );
    const rows: Array<{ token_id: string; balance: number | string }> =
      data.tokens ?? [];
    const joined = await Promise.all(
      rows.map(async (t) => {
        const info = await this.getTokenInfo(t.token_id);
        if (info.type !== "FUNGIBLE_COMMON") return null;
        const balanceRaw = BigInt(t.balance ?? 0);
        const balance = formatTokenAmount(balanceRaw, info.decimals);
        return {
          ...info,
          balanceRaw,
          balance,
          usdEstimate:
            info.tokenId === USDC_TOKEN_IDS[this.cfg.network]
              ? Number(balance) // USDC is 1:1 by definition of the estimate
              : null,
        } satisfies TokenBalance;
      }),
    );
    return joined.filter((t): t is TokenBalance => t != null);
  }

  /** Topics this account created (from its CONSENSUSCREATETOPIC history). */
  async getCreatedTopics(accountId: string): Promise<TopicRef[]> {
    const params = new URLSearchParams({
      "account.id": accountId,
      transactiontype: "CONSENSUSCREATETOPIC",
      result: "success",
      limit: "50",
      order: "desc",
    });
    const data = await this.get<any>(`/api/v1/transactions?${params}`);
    const topics: TopicRef[] = [];
    for (const tx of data.transactions ?? []) {
      if (!tx.entity_id) continue;
      topics.push({
        topicId: tx.entity_id,
        createdAt: new Date(
          Math.floor(Number(tx.consensus_timestamp) * 1000),
        ).toISOString(),
      });
    }
    return topics;
  }

  /** Latest messages on a topic, newest first, UTF-8 decoded. */
  async getTopicMessages(
    topicId: string,
    limit = 25,
  ): Promise<TopicMessage[]> {
    const data = await this.get<any>(
      `/api/v1/topics/${encodeURIComponent(topicId)}/messages?order=desc&limit=${limit}`,
    );
    return (data.messages ?? []).map((m: any) => {
      let text = "";
      try {
        const bin = atob(String(m.message ?? ""));
        const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
        text = new TextDecoder().decode(bytes);
      } catch {
        text = "(binary message)";
      }
      return {
        sequenceNumber: Number(m.sequence_number),
        message: text,
        timestamp: new Date(
          Math.floor(Number(m.consensus_timestamp) * 1000),
        ).toISOString(),
        consensusTimestamp: String(m.consensus_timestamp),
      } satisfies TopicMessage;
    });
  }

  /** NFTs the account holds, joined with collection metadata and (best
   * effort) a displayable image resolved from the serial's metadata. */
  async getNfts(accountId: string): Promise<NftItem[]> {
    const data = await this.get<any>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/nfts?limit=50`,
    );
    const rows: Array<{
      token_id: string;
      serial_number: number;
      deleted?: boolean;
      metadata?: string;
    }> = data.nfts ?? [];
    const items = await Promise.all(
      rows
        .filter((n) => !n.deleted)
        .map(async (n) => {
          let name = n.token_id;
          let symbol = "";
          try {
            const info = await this.getTokenInfo(n.token_id);
            name = info.name || n.token_id;
            symbol = info.symbol;
          } catch {
            // Collection metadata failing must not hide the NFT itself.
          }
          const { metadataUri, imageUrl } = await this.resolveNftImage(
            n.token_id,
            n.serial_number,
            n.metadata,
          );
          return {
            tokenId: n.token_id,
            serialNumber: n.serial_number,
            name,
            symbol,
            hashscanUrl: `${this.cfg.hashscanBase}/token/${n.token_id}/${n.serial_number}`,
            metadataUri,
            imageUrl,
          } satisfies NftItem;
        }),
    );
    return items;
  }

  /** serial-metadata resolution cache (token/serial → resolved fields). */
  private nftImageCache = new Map<string, { metadataUri?: string; imageUrl?: string }>();

  /**
   * Best-effort image resolution for one serial. The on-chain metadata
   * (≤100 bytes) is conventionally a URI: either directly to an image, or
   * to a HIP-412 JSON whose `image` field points at one. ipfs:// goes
   * through a public gateway. Every failure degrades to text-only display.
   */
  private async resolveNftImage(
    tokenId: string,
    serial: number,
    metadataBase64: string | undefined,
  ): Promise<{ metadataUri?: string; imageUrl?: string }> {
    const cacheKey = `${tokenId}/${serial}`;
    const cached = this.nftImageCache.get(cacheKey);
    if (cached) return cached;

    const out: { metadataUri?: string; imageUrl?: string } = {};
    try {
      if (metadataBase64) {
        const uri = new TextDecoder()
          .decode(base64urlToBytes(metadataBase64))
          .trim();
        if (/^(ipfs:\/\/|https?:\/\/)/i.test(uri)) {
          out.metadataUri = uri;
          const gatewayed = ipfsToHttps(uri);
          if (/\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(gatewayed)) {
            out.imageUrl = gatewayed;
          } else {
            // Assume HIP-412 JSON; a non-JSON response just leaves text-only.
            const res = await this.fetchImpl(gatewayed, {
              headers: { accept: "application/json" },
            });
            if (res.ok) {
              const json: any = await res.json();
              const image = json?.image ?? json?.pic ?? json?.picture;
              if (typeof image === "string" && image) {
                out.imageUrl = ipfsToHttps(image);
              }
            }
          }
        }
      }
    } catch {
      // Unreachable gateways / malformed metadata → text-only row.
    }
    this.nftImageCache.set(cacheKey, out);
    return out;
  }

  /**
   * Transfer history for an account, newest first — HBAR and HTS token
   * movements. HTS transfers ARE CryptoTransfer transactions on Hedera; they
   * arrive in the same query with a `token_transfers` array, so one tx can
   * yield several items (an HBAR row and/or one row per token moved).
   */
  async getHistory(
    accountId: string,
    opts: { limit?: number; order?: "asc" | "desc"; timestampGt?: string } = {},
  ): Promise<HistoryItem[]> {
    const params = new URLSearchParams({
      "account.id": accountId,
      transactiontype: "CRYPTOTRANSFER",
      result: "success",
      limit: String(opts.limit ?? 25),
      order: opts.order ?? "desc",
    });
    if (opts.timestampGt) params.set("timestamp", `gt:${opts.timestampGt}`);

    const data = await this.get<any>(`/api/v1/transactions?${params}`);
    const items: HistoryItem[] = [];
    for (const tx of data.transactions ?? []) {
      const base = {
        transactionId: tx.transaction_id,
        timestamp: new Date(
          Math.floor(Number(tx.consensus_timestamp) * 1000),
        ).toISOString(),
        consensusTimestamp: tx.consensus_timestamp,
        hashscanUrl: hashscanTxUrl(this.cfg, tx.transaction_id),
        memo: tx.memo_base64
          ? new TextDecoder().decode(base64urlToBytes(tx.memo_base64))
          : undefined,
      };
      const transfers: Array<{ account: string; amount: number }> =
        tx.transfers ?? [];
      const tokenTransfers: Array<{
        token_id: string;
        account: string;
        amount: number;
      }> = tx.token_transfers ?? [];
      const myTokenMoves = tokenTransfers.filter(
        (t) => t.account === accountId && t.amount !== 0,
      );

      // HBAR row. When the only HBAR movement is paying the network fee for
      // a token transfer, drop it — "-0.0018 ℏ" next to "-5 USDC" is noise.
      // charged_tx_fee is exact, so this never hides a real payment.
      const mine = transfers.find((t) => t.account === accountId);
      const feeOnly =
        mine != null &&
        mine.amount < 0 &&
        myTokenMoves.length > 0 &&
        BigInt(-mine.amount) === BigInt(tx.charged_tx_fee ?? 0);
      if (mine && mine.amount !== 0 && !feeOnly) {
        const tinybar = BigInt(mine.amount);
        const direction = tinybar >= 0n ? "in" : "out";
        // Counterparty heuristic: the largest opposite-sign transfer.
        const counter = transfers
          .filter((t) => t.account !== accountId)
          .filter((t) => (direction === "in" ? t.amount < 0 : t.amount > 0))
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
        items.push({
          ...base,
          amount: tinybarToHbar(tinybar),
          tinybar,
          direction,
          counterparty: counter?.account ?? null,
        });
      }

      // Token rows — one per token this account moved in the tx.
      for (const move of myTokenMoves) {
        let symbol = move.token_id;
        let decimals = 0;
        try {
          const info = await this.getTokenInfo(move.token_id);
          symbol = info.symbol || move.token_id;
          decimals = info.decimals;
        } catch {
          // Metadata lookup failing must not hide the movement itself.
        }
        const raw = BigInt(move.amount);
        const direction = raw >= 0n ? "in" : "out";
        const counter = tokenTransfers
          .filter((t) => t.token_id === move.token_id && t.account !== accountId)
          .filter((t) => (direction === "in" ? t.amount < 0 : t.amount > 0))
          .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
        items.push({
          ...base,
          amount: formatTokenAmount(raw, decimals),
          tinybar: raw,
          direction,
          token: { tokenId: move.token_id, symbol, decimals },
          counterparty: counter?.account ?? null,
        });
      }
    }
    return items;
  }
}
