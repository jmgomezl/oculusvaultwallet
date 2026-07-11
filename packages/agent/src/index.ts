/**
 * @oculusvault/agent — the AGENT side of OculusVault's Agent Desk.
 *
 * A human hires you from their OculusVault wallet and hands over show-once
 * credentials: a real Hedera account whose key is a 1-of-2 KeyList
 * [owner, you]. You operate autonomously within what they funded; they stay
 * protocol-level co-owner (they can freeze, sweep, refill, or retire your
 * account at any time — expect it, design for it).
 *
 * The three trust tiers, from your side:
 *   1. Petty cash  — spend() your own balance.
 *   2. Allowance   — drawFromOwner() spends the OWNER's balance up to the
 *                    cap they granted (HIP-336 approved transfer).
 *   3. Ask-me      — requestApproval() files a Scheduled Transaction the
 *                    owner co-signs from their wallet; waitForApproval()
 *                    polls until it executes or expires.
 * Plus the audit log: logActivity() stamps what you did onto your HCS topic
 * (tamper-evident, owner-readable, public).
 *
 * Nothing here touches the owner's keys — you only ever hold your own.
 */
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  Timestamp,
  TopicId,
  TopicMessageSubmitTransaction,
  TransferTransaction,
} from "@hashgraph/sdk";

export type HederaNetwork = "testnet" | "mainnet" | "previewnet";

export interface AgentCredentials {
  network: HederaNetwork;
  /** Your agent account id (0.0.x) from the show-once handoff. */
  accountId: string;
  /** Your ECDSA private key (hex) from the show-once handoff. */
  privateKey: string;
  /** The hiring owner's account id — required for tiers 2 and 3. */
  ownerAccountId?: string;
  /** Your HCS audit topic, if the owner created one. */
  auditTopicId?: string;
  /** Override the Mirror Node REST base (tests / private mirrors). */
  mirrorBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface AgentSendResult {
  transactionId: string;
  status: string;
}

export interface ApprovalRequest {
  scheduleId: string;
  status: string;
  /** When the request lapses if the owner never signs. */
  expiresAt: Date;
}

export type ApprovalOutcome = "executed" | "expired" | "timeout";

const MIRROR_BASES: Record<HederaNetwork, string> = {
  testnet: "https://testnet.mirrornode.hedera.com",
  mainnet: "https://mainnet.mirrornode.hedera.com",
  previewnet: "https://previewnet.mirrornode.hedera.com",
};

function clientFor(network: HederaNetwork): Client {
  switch (network) {
    case "testnet":
      return Client.forTestnet();
    case "mainnet":
      return Client.forMainnet();
    case "previewnet":
      return Client.forPreviewnet();
    default:
      throw new Error(`Unsupported network: ${network}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OculusAgent {
  readonly network: HederaNetwork;
  readonly accountId: string;
  readonly ownerAccountId?: string;
  readonly auditTopicId?: string;
  private readonly key: PrivateKey;
  private readonly mirrorBase: string;
  private readonly fetchImpl: typeof fetch;

  private constructor(creds: AgentCredentials) {
    this.network = creds.network;
    this.accountId = creds.accountId;
    this.ownerAccountId = creds.ownerAccountId;
    this.auditTopicId = creds.auditTopicId;
    this.key = PrivateKey.fromStringECDSA(creds.privateKey);
    this.mirrorBase = creds.mirrorBaseUrl ?? MIRROR_BASES[creds.network];
    this.fetchImpl = creds.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  /** Connect with the credentials the Agent Desk handed over. Accepts the
   * copy-pasted JSON object or env-style fields. */
  static connect(creds: AgentCredentials): OculusAgent {
    if (!/^0\.0\.\d+$/.test(creds.accountId)) {
      throw new Error("accountId must be a 0.0.x Hedera account id");
    }
    return new OculusAgent(creds);
  }

  private withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = clientFor(this.network).setOperator(
      AccountId.fromString(this.accountId),
      this.key,
    );
    return fn(client).finally(() => client.close());
  }

  private async mirror<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.mirrorBase}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Mirror ${res.status} for ${path}`);
    return (await res.json()) as T;
  }

  /** Your petty-cash balance, as a decimal HBAR string. Frozen/retired
   * accounts still resolve — spend() is what fails when you're frozen. */
  async getBalance(): Promise<string> {
    const data = await this.mirror<any>(`/api/v1/accounts/${this.accountId}?limit=1`);
    const tinybar = BigInt(data.balance?.balance ?? 0);
    const whole = tinybar / 100_000_000n;
    const frac = (tinybar % 100_000_000n).toString().padStart(8, "0");
    return `${whole}.${frac}`;
  }

  /** Tier 1: spend your own petty cash. Fails with INVALID_SIGNATURE the
   * moment the owner freezes you — treat that as "stop working". */
  async spend(
    to: string,
    amountHbar: string | number,
    memo?: string,
  ): Promise<AgentSendResult> {
    const amount = Hbar.fromString(String(amountHbar));
    if (amount.toTinybars().toNumber() <= 0) {
      throw new Error("Amount must be positive");
    }
    return this.withClient(async (client) => {
      let tx = new TransferTransaction()
        .addHbarTransfer(this.accountId, amount.negated())
        .addHbarTransfer(to, amount);
      if (memo) tx = tx.setTransactionMemo(memo);
      const response = await tx.execute(client);
      const receipt = await response.getReceipt(client);
      return {
        transactionId: response.transactionId.toString(),
        status: receipt.status.toString(),
      };
    });
  }

  /** Tier 2: spend from the OWNER's balance within the allowance they
   * granted (HIP-336). `to` defaults to your own account. Fails with
   * AMOUNT_EXCEEDS_ALLOWANCE / SPENDER_DOES_NOT_HAVE_ALLOWANCE when you're
   * over the cap or revoked. */
  async drawFromOwner(
    amountHbar: string | number,
    to?: string,
    memo?: string,
  ): Promise<AgentSendResult> {
    if (!this.ownerAccountId) {
      throw new Error("ownerAccountId is required to draw on an allowance");
    }
    const amount = Hbar.fromString(String(amountHbar));
    if (amount.toTinybars().toNumber() <= 0) {
      throw new Error("Amount must be positive");
    }
    return this.withClient(async (client) => {
      let tx = new TransferTransaction()
        .addApprovedHbarTransfer(this.ownerAccountId!, amount.negated())
        .addHbarTransfer(to ?? this.accountId, amount);
      if (memo) tx = tx.setTransactionMemo(memo);
      const response = await tx.execute(client);
      const receipt = await response.getReceipt(client);
      return {
        transactionId: response.transactionId.toString(),
        status: receipt.status.toString(),
      };
    });
  }

  /**
   * Tier 3: ask the owner. Files a Scheduled Transaction moving
   * `amountHbar` from the owner to `to` (default: you). It executes ONLY
   * when the owner signs it in OculusVault; otherwise it expires
   * harmlessly. Default expiry is ~30 minutes; pass `expiresInMinutes`
   * (up to ~2 months) for longer-lived requests.
   */
  async requestApproval(args: {
    amountHbar: string | number;
    to?: string;
    memo?: string;
    expiresInMinutes?: number;
  }): Promise<ApprovalRequest> {
    if (!this.ownerAccountId) {
      throw new Error("ownerAccountId is required to request approval");
    }
    const amount = Hbar.fromString(String(args.amountHbar));
    if (amount.toTinybars().toNumber() <= 0) {
      throw new Error("Amount must be positive");
    }
    return this.withClient(async (client) => {
      const inner = new TransferTransaction()
        .addHbarTransfer(this.ownerAccountId!, amount.negated())
        .addHbarTransfer(args.to ?? this.accountId, amount);
      let schedule = inner.schedule();
      if (args.memo) schedule = schedule.setScheduleMemo(args.memo);
      let expiresAt = new Date(Date.now() + 30 * 60_000);
      if (args.expiresInMinutes != null) {
        if (args.expiresInMinutes < 1) throw new Error("expiresInMinutes must be ≥ 1");
        expiresAt = new Date(Date.now() + args.expiresInMinutes * 60_000);
        schedule = schedule
          .setExpirationTime(Timestamp.fromDate(expiresAt))
          .setWaitForExpiry(false);
      }
      const response = await schedule.execute(client);
      const receipt = await response.getReceipt(client);
      if (!receipt.scheduleId) throw new Error("Network returned no schedule id");
      return {
        scheduleId: receipt.scheduleId.toString(),
        status: receipt.status.toString(),
        expiresAt,
      };
    });
  }

  /** Poll the mirror until the owner signs (executed), the request lapses
   * (expired/deleted), or `timeoutMs` elapses. */
  async waitForApproval(
    request: Pick<ApprovalRequest, "scheduleId" | "expiresAt">,
    opts: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<ApprovalOutcome> {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    const pollMs = opts.pollMs ?? 5_000;
    for (;;) {
      try {
        const s = await this.mirror<any>(`/api/v1/schedules/${request.scheduleId}`);
        if (s.executed_timestamp != null) return "executed";
        if (s.deleted) return "expired";
      } catch {
        // Mirror lag right after creation — keep polling.
      }
      if (Date.now() >= request.expiresAt.getTime()) return "expired";
      if (Date.now() >= deadline) return "timeout";
      await sleep(pollMs);
    }
  }

  /** Stamp an entry onto your HCS audit topic — an append-only, consensus-
   * timestamped record the owner (and anyone) can verify. ≤1024 bytes. */
  async logActivity(message: string, topicId?: string): Promise<AgentSendResult> {
    const topic = topicId ?? this.auditTopicId;
    if (!topic) throw new Error("No audit topic — pass topicId or set auditTopicId");
    const bytes = new TextEncoder().encode(message);
    if (bytes.length === 0 || bytes.length > 1024) {
      throw new Error("Audit entries must be 1–1024 bytes");
    }
    return this.withClient(async (client) => {
      const response = await new TopicMessageSubmitTransaction()
        .setTopicId(TopicId.fromString(topic))
        .setMessage(bytes)
        .execute(client);
      const receipt = await response.getReceipt(client);
      return {
        transactionId: response.transactionId.toString(),
        status: receipt.status.toString(),
      };
    });
  }
}

export default OculusAgent;
