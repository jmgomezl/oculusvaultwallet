/**
 * Hedera Mirror Node REST client (read path): account resolution, balance,
 * transfer history, and incoming-transfer polling. No SDK/gRPC needed for
 * reads — plain HTTP works in the browser and Node alike.
 */
import type { Balance, HistoryItem, TokenBalance, TokenInfo } from "../types.js";
import { base64urlToBytes } from "../crypto/encoding.js";
import { formatTokenAmount } from "./tokenAmount.js";
import { hashscanTxUrl, type NetworkConfig } from "./networks.js";

const TINYBAR_PER_HBAR = 100_000_000n;

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
        return {
          ...info,
          balanceRaw,
          balance: formatTokenAmount(balanceRaw, info.decimals),
        } satisfies TokenBalance;
      }),
    );
    return joined.filter((t): t is TokenBalance => t != null);
  }

  /**
   * Crypto-transfer history for an account, newest first. Each Hedera
   * transaction carries a `transfers` array; we collapse it to this account's
   * net HBAR movement.
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
      const transfers: Array<{ account: string; amount: number }> =
        tx.transfers ?? [];
      const mine = transfers.find((t) => t.account === accountId);
      if (!mine || mine.amount === 0) continue;
      const tinybar = BigInt(mine.amount);
      const direction = tinybar >= 0n ? "in" : "out";
      // Counterparty heuristic: the largest opposite-sign transfer.
      const counter = transfers
        .filter((t) => t.account !== accountId)
        .filter((t) =>
          direction === "in" ? t.amount < 0 : t.amount > 0,
        )
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
      items.push({
        transactionId: tx.transaction_id,
        amount: tinybarToHbar(tinybar),
        tinybar,
        direction,
        counterparty: counter?.account ?? null,
        timestamp: new Date(
          Math.floor(Number(tx.consensus_timestamp) * 1000),
        ).toISOString(),
        consensusTimestamp: tx.consensus_timestamp,
        hashscanUrl: hashscanTxUrl(this.cfg, tx.transaction_id),
        memo: tx.memo_base64
          ? new TextDecoder().decode(base64urlToBytes(tx.memo_base64))
          : undefined,
      });
    }
    return items;
  }
}
