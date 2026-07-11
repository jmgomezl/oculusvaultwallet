/**
 * WalletConnect bridge — lets any Hedera dApp (SaucerSwap & friends) use
 * OculusVault as its signer over WalletConnect v2 / HIP-820. The dApp builds
 * transactions on its own battle-tested UI; this wallet's only new job is to
 * show the user WHAT they're signing and sign locally on approval. Every
 * request is user-approved here — nothing signs silently.
 *
 * The heavy lifting (pairing, session store, HIP-820 request codecs) is
 * @hashgraph/hedera-wallet-connect; this file adapts it to OculusVault and
 * to plain callbacks the React UI can render.
 */
import {
  HederaChainId,
  Wallet as HederaWeb3Wallet,
} from "@hashgraph/hedera-wallet-connect";
import { getSdkError } from "@walletconnect/utils";
import { PrivateKey, Query, Transaction } from "@hashgraph/sdk";
import {
  describeTransaction,
  type HederaNetwork,
  type OculusVault,
} from "@oculusvault/sdk";

export interface WcDapp {
  name: string;
  url: string;
}
export interface WcProposal extends WcDapp {
  approve(): Promise<void>;
  reject(): Promise<void>;
}
export interface WcRequest extends WcDapp {
  method: string;
  /** Human summary of what will be signed/executed. */
  summary: string;
  approve(): Promise<void>;
  reject(): Promise<void>;
}
export interface WcSession extends WcDapp {
  topic: string;
}

export interface WcBridgeOptions {
  projectId: string;
  network: HederaNetwork;
  /** Must be unlocked with an on-ledger account. */
  wallet: OculusVault;
  onProposal(p: WcProposal): void;
  onRequest(r: WcRequest): void;
  onSessionsChanged(sessions: WcSession[]): void;
}

function chainFor(network: HederaNetwork): HederaChainId {
  if (network === "mainnet") return HederaChainId.Mainnet;
  if (network === "previewnet") return HederaChainId.Previewnet;
  return HederaChainId.Testnet;
}

/** WalletConnect Core tolerates exactly one init per page; cache the client
 * and re-bind handlers on each bridge creation (e.g. network switch). */
let wcClient: HederaWeb3Wallet | null = null;
/** Handlers from the previous bridge, so a remount replaces instead of stacks. */
let prevHandlers: {
  proposal?: (...args: any[]) => void;
  request?: (...args: any[]) => void;
  del?: (...args: any[]) => void;
} = {};

export class WcBridge {
  private constructor(
    private readonly wc: HederaWeb3Wallet,
    private readonly opts: WcBridgeOptions,
    private readonly chainId: HederaChainId,
  ) {}

  static async create(opts: WcBridgeOptions): Promise<WcBridge> {
    const chainId = chainFor(opts.network);
    if (!wcClient) {
      wcClient = await HederaWeb3Wallet.create(
        opts.projectId,
        {
          name: "OculusVault",
          description:
            "Non-custodial Hedera wallet anchored to your Telegram identity",
          url: "https://oculusvault.com",
          icons: ["https://oculusvault.com/icons/icon128.png"],
        },
        [chainId],
      );
    }
    const wc = wcClient;
    // A fresh bridge (remount / network switch) replaces prior handlers.
    if (prevHandlers.proposal) wc.off("session_proposal", prevHandlers.proposal as any);
    if (prevHandlers.request) wc.off("session_request", prevHandlers.request as any);
    if (prevHandlers.del) wc.off("session_delete", prevHandlers.del as any);
    wc.chains = [chainId];

    const bridge = new WcBridge(wc, opts, chainId);

    const onProposal = (proposal: any) => {
      const meta = proposal.params.proposer.metadata;
      opts.onProposal({
        name: meta.name || "Unknown app",
        url: meta.url || "",
        approve: async () => {
          const accountId = opts.wallet.getIdentity().hederaAccountId;
          if (!accountId) {
            await wc.rejectSession({
              id: proposal.id,
              reason: getSdkError("UNSUPPORTED_ACCOUNTS"),
            });
            throw new Error(
              "This wallet has no on-ledger account yet — receive HBAR first.",
            );
          }
          await wc.buildAndApproveSession([`${chainId}:${accountId}`], proposal);
          bridge.emitSessions();
        },
        reject: async () => {
          await wc.rejectSession({
            id: proposal.id,
            reason: getSdkError("USER_REJECTED"),
          });
        },
      });
    };

    const onRequest = async (event: any) => {
      let parsed: ReturnType<HederaWeb3Wallet["parseSessionRequest"]>;
      try {
        parsed = wc.parseSessionRequest(event);
      } catch {
        await wc.rejectSessionRequest(event, getSdkError("INVALID_METHOD"));
        return;
      }
      const peer = wc.getActiveSessions()[event.topic]?.peer.metadata;
      const body = parsed.body;
      const summary =
        body instanceof Transaction
          ? describeTransaction(body)
          : typeof body === "string"
            ? `Sign this message: “${body}”`
            : body instanceof Uint8Array
              ? "Sign a raw transaction (contents not decodable — be careful)"
              : body instanceof Query
                ? "Run a read-only query (no funds move)"
                : parsed.method;
      opts.onRequest({
        name: peer?.name || "Connected app",
        url: peer?.url || "",
        method: parsed.method,
        summary,
        approve: async () => {
          const accountId =
            parsed.accountId?.toString() ??
            opts.wallet.getIdentity().hederaAccountId;
          if (!accountId) throw new Error("No account to sign with.");
          // The key stays in OculusVault memory; a signer is built only for
          // the duration of this single approved request.
          //
          // getHederaWallet() feeds the key straight into @hashgraph/sdk's
          // Wallet ctor, which runs PrivateKey.fromString() on a raw hex
          // string — and THAT DEFAULTS TO ED25519. Our accounts are secp256k1
          // (ECDSA), so a raw-hex key is parsed as the wrong curve and every
          // signature fails on-ledger precheck with INVALID_SIGNATURE. Hand it
          // a DER-encoded ECDSA key: the ctor detects DER and keeps the curve.
          const ecdsaDerKey = PrivateKey.fromStringECDSA(
            await opts.wallet.exportKey(),
          ).toStringDer();
          const signer = wc.getHederaWallet(
            parsed.chainId,
            accountId,
            ecdsaDerKey,
          );
          await wc.executeSessionRequest(event, signer);
        },
        reject: async () => {
          await wc.rejectSessionRequest(event, getSdkError("USER_REJECTED"));
        },
      });
    };

    const onDelete = () => bridge.emitSessions();
    wc.on("session_proposal", onProposal);
    wc.on("session_request", onRequest);
    wc.on("session_delete", onDelete);
    prevHandlers = { proposal: onProposal, request: onRequest, del: onDelete };
    bridge.emitSessions();
    return bridge;
  }

  /** Pair with a dApp from a scanned/pasted wc: URI. */
  async pair(uri: string): Promise<void> {
    if (!/^wc:/.test(uri.trim())) {
      throw new Error("That doesn’t look like a WalletConnect (wc:) link.");
    }
    await this.wc.pair({ uri: uri.trim() });
  }

  sessions(): WcSession[] {
    return Object.values(this.wc.getActiveSessions()).map((s) => ({
      topic: s.topic,
      name: s.peer.metadata.name || "Connected app",
      url: s.peer.metadata.url || "",
    }));
  }

  async disconnect(topic: string): Promise<void> {
    await this.wc.disconnectSession({
      topic,
      reason: getSdkError("USER_DISCONNECTED"),
    });
    this.emitSessions();
  }

  private emitSessions(): void {
    this.opts.onSessionsChanged(this.sessions());
  }
}
