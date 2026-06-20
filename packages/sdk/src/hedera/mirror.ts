/**
 * Hedera Mirror Node REST client (read path): account resolution, balance,
 * transfer history, and incoming-transfer polling. No SDK/gRPC needed for
 * reads — plain HTTP works in the browser and Node alike.
 */
import type { Balance, HistoryItem } from "../types.js";
import { base64urlToBytes } from "../crypto/encoding.js";
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

  async getBalance(idOrEvm: string): Promise<Balance> {
    const acct = await this.resolveAccount(idOrEvm);
    const tinybar = acct?.balanceTinybar ?? 0n;
    return { hbar: tinybarToHbar(tinybar), tinybar, usdEstimate: null };
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
