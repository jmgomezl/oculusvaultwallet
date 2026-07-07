/**
 * OculusVault Hardware — a Ledger on Hedera, without the Hedera Ledger app.
 *
 * The official Hedera Ledger app is ED25519-only and can't display HTS or
 * contract calls. This page routes around it: the Ledger ETHEREUM app holds a
 * secp256k1 key, that key IS a Hedera account (EVM alias), and everything
 * signs as plain EVM transactions through the JSON-RPC relay (Hashio):
 *   • Receive HBAR + ANY HTS token: zero signing — alias-created accounts
 *     have unlimited automatic association (HIP-904, verified on-ledger).
 *   • Send HBAR: native value transfer.
 *   • Send HTS tokens: ERC-20 `transfer()` on the token's EVM facade.
 *   • Execute smart contracts: to + data + value, like any EVM chain.
 * The private key never leaves the device; this page never sees a secret.
 *
 * Desktop Chrome/Edge only (WebHID). Not available inside Telegram webviews —
 * which is exactly why it lives here as a standalone page.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import Eth from "@ledgerhq/hw-app-eth";
import { Transaction as EvmTx } from "micro-eth-signer";
import {
  MirrorClient,
  getNetworkConfig,
  EVM_CHAIN_IDS,
  hbarToWeibar,
  entityEvmAddress,
  erc20TransferData,
  parseTokenAmount,
  type HederaNetwork,
  type NetworkConfig,
  type TokenBalance,
} from "@oculusvault/sdk";
import { Qr } from "./Qr.js";
import { Aperture } from "./Aperture.js";
import "./styles.css";

/** Standard Ethereum derivation path — what Ledger Live and MetaMask use, so
 * an account created elsewhere with the same device shows up identically. */
const PATH = "44'/60'/0'/0/0";
const NET_KEY = "ovhw:network";

function loadSavedNetwork(): HederaNetwork {
  try {
    const v = localStorage.getItem(NET_KEY);
    if (v === "mainnet" || v === "testnet") return v;
  } catch { /* fine */ }
  return "testnet";
}

function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}
function formatHbar(hbar: string): string {
  if (!hbar.includes(".")) return hbar;
  return hbar.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

// ---------- JSON-RPC relay ----------

async function rpc<T>(cfg: NetworkConfig, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(cfg.jsonRpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(json.error.message ?? `Relay error on ${method}`);
  }
  return json.result as T;
}

interface EvmSendArgs {
  eth: Eth;
  cfg: NetworkConfig;
  network: HederaNetwork;
  from: string;
  to: string;
  valueWeibar: bigint;
  data?: string;
  onStatus(text: string): void;
}

/** Build → device-sign → broadcast → wait. The only signer is the Ledger. */
async function sendViaLedger(args: EvmSendArgs): Promise<{ hash: string }> {
  const { eth, cfg, network, from, to, valueWeibar, data, onStatus } = args;

  onStatus("Preparing transaction…");
  const [nonceHex, gasPriceHex] = await Promise.all([
    rpc<string>(cfg, "eth_getTransactionCount", [from, "latest"]),
    rpc<string>(cfg, "eth_gasPrice", []),
  ]);
  const gasPrice = BigInt(gasPriceHex);
  let gasLimit: bigint;
  try {
    const est = await rpc<string>(cfg, "eth_estimateGas", [
      {
        from,
        to,
        value: `0x${valueWeibar.toString(16)}`,
        ...(data ? { data } : {}),
      },
    ]);
    gasLimit = (BigInt(est) * 12n) / 10n; // 20% headroom
  } catch {
    gasLimit = data ? 800_000n : 21_000n;
  }

  const unsigned = EvmTx.prepare(
    {
      type: "eip1559",
      chainId: BigInt(EVM_CHAIN_IDS[network]),
      nonce: BigInt(nonceHex),
      to,
      value: valueWeibar,
      maxFeePerGas: gasPrice,
      maxPriorityFeePerGas: gasPrice,
      gasLimit,
      ...(data ? { data } : {}),
    },
    false,
  );

  onStatus("Confirm on your Ledger…");
  const sig = await eth.signTransaction(PATH, unsigned.toHex(false).slice(2), null);

  const signed = new EvmTx(
    unsigned.type,
    {
      ...unsigned.raw,
      yParity: parseInt(sig.v, 16),
      r: BigInt(`0x${sig.r}`),
      s: BigInt(`0x${sig.s}`),
    },
    false,
    true,
  );

  onStatus("Broadcasting to the relay…");
  const hash = await rpc<string>(cfg, "eth_sendRawTransaction", [signed.toHex(true)]);

  onStatus("Waiting for consensus…");
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const receipt = await rpc<{ status: string } | null>(
      cfg,
      "eth_getTransactionReceipt",
      [hash],
    ).catch(() => null);
    if (receipt) {
      if (receipt.status !== "0x1") {
        throw new Error("Transaction reverted on-chain — nothing was transferred.");
      }
      return { hash };
    }
  }
  throw new Error("Timed out waiting for the receipt — check Hashscan before retrying.");
}

/** Resolve a recipient (0x… or 0.0.x) to an EVM address the relay accepts. */
async function resolveRecipient(mirror: MirrorClient, to: string): Promise<string> {
  const t = to.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(t)) return t;
  if (/^0\.0\.[0-9]+$/.test(t)) {
    const acct = await mirror.resolveAccount(t);
    if (!acct) throw new Error(`Account ${t} doesn’t exist on this network.`);
    return acct.evmAddress ?? entityEvmAddress(t);
  }
  throw new Error("Recipient must be a 0x address or 0.0.x id.");
}

// ---------- UI ----------

type Phase = "unsupported" | "connect" | "ready";

function App() {
  const [network, setNetwork] = useState<HederaNetwork>(loadSavedNetwork);
  const [phase, setPhase] = useState<Phase>(
    typeof (navigator as { hid?: unknown }).hid === "undefined" ? "unsupported" : "connect",
  );
  const ethRef = useRef<Eth | null>(null);
  const [address, setAddress] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [err, setErr] = useState("");

  const cfg = getNetworkConfig(network);
  const mirrorRef = useRef(new MirrorClient(cfg));
  mirrorRef.current = new MirrorClient(cfg);

  const connect = useCallback(async () => {
    setErr("");
    try {
      const transport = await TransportWebHID.create();
      const eth = new Eth(transport);
      const { address: addr } = await eth.getAddress(PATH, false);
      ethRef.current = eth;
      setAddress(addr);
      setPhase("ready");
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      setErr(
        /0x6511|0x6e00|app/i.test(msg)
          ? "Open the ETHEREUM app on your Ledger, then try again."
          : msg,
      );
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const mirror = mirrorRef.current;
      const acct = await mirror.resolveAccount(address);
      setAccountId(acct?.accountId ?? null);
      if (acct) {
        const [b, t] = await Promise.all([
          mirror.getBalance(acct.accountId),
          mirror.getTokenBalances(acct.accountId),
        ]);
        setBalance(b.hbar);
        setTokens(t);
      } else {
        setBalance("0");
        setTokens([]);
      }
    } catch { /* transient mirror failure — next poll retries */ }
  }, [address, network]);

  useEffect(() => {
    if (phase !== "ready") return;
    refresh();
    const poll = setInterval(refresh, 8000);
    return () => clearInterval(poll);
  }, [phase, refresh]);

  const switchNetwork = (n: HederaNetwork) => {
    try { localStorage.setItem(NET_KEY, n); } catch { /* fine */ }
    setNetwork(n);
    setAccountId(null);
    setBalance(null);
    setTokens([]);
  };

  if (phase === "unsupported") {
    return (
      <div className="app centered">
        <Aperture size={56} />
        <h2>Needs a desktop browser</h2>
        <p className="muted small">
          Ledger devices connect over WebHID, which this browser doesn’t
          expose. Open this page in Chrome or Edge on a computer.
        </p>
      </div>
    );
  }

  if (phase === "connect") {
    return (
      <div className="app unlock">
        <div className="unlock-mark"><Aperture size={84} hero /></div>
        <h1 className="unlock-title">OculusVault Hardware</h1>
        <p className="muted small unlock-sub">
          Use a <strong>Ledger</strong> on Hedera — receive any token, send
          HBAR and HTS, execute smart contracts. Keys never leave the device.
          Plug in your Ledger and open the <strong>Ethereum app</strong> (the
          Hedera app isn’t needed — that’s the point).
        </p>
        <div className="card">
          <button className="btn primary" onClick={connect}>
            Connect Ledger
          </button>
          {err && <p className="error">{err}</p>}
          <p className="muted xsmall">
            Works because your Ledger’s secp256k1 key <em>is</em> a Hedera
            account: transactions travel as EVM transactions via the public
            JSON-RPC relay, and the Ethereum app displays them for approval.
          </p>
        </div>
        <p className="muted xsmall unlock-foot">
          Non-custodial · nothing to install · open-source (Apache-2.0)
        </p>
      </div>
    );
  }

  return (
    <div className={network === "mainnet" ? "app on-mainnet" : "app"}>
      <header className="header">
        <span className="logo"><Aperture size={22} /> OculusVault Hardware</span>
        <div className="netswitch" role="tablist" aria-label="Network">
          <button
            role="tab"
            aria-selected={network === "testnet"}
            className={network === "testnet" ? "seg active" : "seg"}
            onClick={() => switchNetwork("testnet")}
          >
            Testnet
          </button>
          <button
            role="tab"
            aria-selected={network === "mainnet"}
            className={network === "mainnet" ? "seg active gold-seg" : "seg"}
            onClick={() => switchNetwork("mainnet")}
          >
            Mainnet
          </button>
        </div>
      </header>
      {network === "mainnet" && (
        <div className="mainnet-strip">Real HBAR · beta, unaudited — keep small amounts</div>
      )}

      <section className="balance-hero">
        <span className="balance-label">Ledger balance · {network}</span>
        <div className="balance">{balance != null ? formatHbar(balance) : "…"} ℏ</div>
        <div className="id-row">
          <button className="chip" onClick={() => navigator.clipboard.writeText(address)}>
            {shortAddr(address)}
          </button>
          {accountId ? (
            <a className="chip" href={`${cfg.hashscanBase}/account/${accountId}`} target="_blank" rel="noreferrer">
              Nº {accountId} ↗
            </a>
          ) : (
            <span className="chip chip-pending">Nº pending first deposit</span>
          )}
        </div>
      </section>

      <ReceiveCard address={address} network={network} verify={async () => {
        await ethRef.current?.getAddress(PATH, true);
      }} />

      {tokens.length > 0 && (
        <div className="card">
          <h3>Tokens</h3>
          {tokens.map((t) => (
            <div className="acct-row" key={t.tokenId}>
              <span>
                <strong>{t.symbol}</strong>{" "}
                <span className="muted xsmall">{t.name}</span>
              </span>
              <span className="amt">{t.balance}</span>
            </div>
          ))}
        </div>
      )}

      <SendCard
        eth={ethRef.current!}
        cfg={cfg}
        network={network}
        from={address}
        accountReady={accountId != null}
        balance={balance}
        tokens={tokens}
        mirror={mirrorRef.current}
        onDone={refresh}
      />

      <ContractCard
        eth={ethRef.current!}
        cfg={cfg}
        network={network}
        from={address}
        accountReady={accountId != null}
        mirror={mirrorRef.current}
        onDone={refresh}
      />

      <footer className="footer muted xsmall">
        Native-only operations (staking, scheduled transactions) aren’t on the
        hardware path yet — the Telegram wallet covers those. Keys never leave
        your Ledger.
      </footer>
    </div>
  );
}

function ReceiveCard({
  address,
  network,
  verify,
}: {
  address: string;
  network: HederaNetwork;
  verify: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);
  return (
    <div className="card center">
      <div className="qr-frame"><Qr value={address} /></div>
      <code
        className="addr"
        onClick={() => {
          navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {address}
      </code>
      <button className="btn primary" onClick={() => navigator.clipboard.writeText(address)}>
        {copied ? "Copied ✓" : "Copy address"}
      </button>
      <button
        className="btn ghost"
        disabled={verifying}
        onClick={async () => {
          setVerifying(true);
          try { await verify(); } finally { setVerifying(false); }
        }}
      >
        {verifying ? "Check your Ledger…" : "Verify address on device"}
      </button>
      <p className="muted small">
        This account accepts <strong>any Hedera token automatically</strong> —
        no association step, ever (unlimited auto-association is the default
        for accounts like this one). First HBAR received creates the account
        on-ledger.
      </p>
      {network === "testnet" && (
        <a className="voucher" href="https://faucet.hedera.com" target="_blank" rel="noreferrer"
           onClick={() => navigator.clipboard.writeText(address)}>
          <span className="voucher-tag">Free ℏ</span>
          <span className="voucher-text">
            Claim testnet ℏ at the official faucet ↗ — <strong>we copy your
            address as you click</strong>, just paste it there.
          </span>
        </a>
      )}
    </div>
  );
}

function SendCard({
  eth, cfg, network, from, accountReady, balance, tokens, mirror, onDone,
}: {
  eth: Eth;
  cfg: NetworkConfig;
  network: HederaNetwork;
  from: string;
  accountReady: boolean;
  balance: string | null;
  tokens: TokenBalance[];
  mirror: MirrorClient;
  onDone: () => void;
}) {
  const [asset, setAsset] = useState("hbar");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const token = asset === "hbar" ? null : tokens.find((t) => t.tokenId === asset) ?? null;

  const send = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const a = Number(amount);
      if (!Number.isFinite(a) || a <= 0) throw new Error("Enter a positive amount.");
      if (token && a > Number(token.balance)) {
        throw new Error(`More than your ${token.symbol} balance (${token.balance}).`);
      }
      if (!token && balance != null && a > Number(balance)) {
        throw new Error(`More than your balance (${formatHbar(balance)} ℏ).`);
      }
      const recipientEvm = await resolveRecipient(mirror, to);
      const { hash } = token
        ? await sendViaLedger({
            eth, cfg, network, from,
            to: entityEvmAddress(token.tokenId),
            valueWeibar: 0n,
            data: erc20TransferData(recipientEvm, parseTokenAmount(amount, token.decimals)),
            onStatus: setStatus,
          })
        : await sendViaLedger({
            eth, cfg, network, from,
            to: recipientEvm,
            valueWeibar: hbarToWeibar(amount),
            onStatus: setStatus,
          });
      setMsg({
        ok: true,
        text: `Sent ${amount} ${token ? token.symbol : "ℏ"} · SUCCESS`,
        url: `${cfg.hashscanBase}/transaction/${hash}`,
      });
      setTo(""); setAmount("");
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  return (
    <div className="card">
      <h3>Send</h3>
      {!accountReady ? (
        <p className="muted small">
          <span className="pending-stamp">Pending</span> Sending unlocks after
          the first deposit creates this account on-ledger.
        </p>
      ) : (
        <>
          {tokens.length > 0 && (
            <select className="input" value={asset} aria-label="Asset to send"
                    onChange={(e) => { setAsset(e.target.value); setMsg(null); }}>
              <option value="hbar">HBAR (ℏ)</option>
              {tokens.map((t) => (
                <option key={t.tokenId} value={t.tokenId}>
                  {t.symbol} — {t.balance} available
                </option>
              ))}
            </select>
          )}
          <input className="input" placeholder="Recipient (0x… or 0.0.…)" value={to}
                 onChange={(e) => setTo(e.target.value)} />
          <input className="input" placeholder={token ? `Amount (${token.symbol})` : "Amount (HBAR)"}
                 inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          {token && (
            <p className="muted xsmall">
              Travels as an ERC-20 <code>transfer()</code> on the token’s EVM
              facade — your Ledger shows the contract call to approve.
            </p>
          )}
          <button className="btn primary" disabled={busy || !to || !amount} onClick={send}>
            {busy ? status || "Working…" : "Review on Ledger & send"}
          </button>
        </>
      )}
      {msg && (
        <p className={msg.ok ? "success" : "error"}>
          {msg.text}{" "}
          {msg.url && <a className="link" href={msg.url} target="_blank" rel="noreferrer">View ↗</a>}
        </p>
      )}
    </div>
  );
}

function ContractCard({
  eth, cfg, network, from, accountReady, mirror, onDone,
}: {
  eth: Eth;
  cfg: NetworkConfig;
  network: HederaNetwork;
  from: string;
  accountReady: boolean;
  mirror: MirrorClient;
  onDone: () => void;
}) {
  const [to, setTo] = useState("");
  const [value, setValue] = useState("");
  const [data, setData] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const call = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const d = data.trim();
      if (d && !/^0x[0-9a-fA-F]*$/.test(d)) {
        throw new Error("Calldata must be 0x-prefixed hex.");
      }
      const target = await resolveRecipient(mirror, to);
      const { hash } = await sendViaLedger({
        eth, cfg, network, from,
        to: target,
        valueWeibar: value ? hbarToWeibar(value) : 0n,
        data: d || undefined,
        onStatus: setStatus,
      });
      setMsg({ ok: true, text: "Contract call executed · SUCCESS",
               url: `${cfg.hashscanBase}/transaction/${hash}` });
      onDone();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  return (
    <div className="card">
      <h3>Execute a smart contract</h3>
      {!accountReady ? (
        <p className="muted small">
          <span className="pending-stamp">Pending</span> Unlocks after the
          first deposit creates this account on-ledger.
        </p>
      ) : (
        <>
          <p className="muted small">
            Any Hedera contract, straight from your Ledger — the thing the
            official Hedera Ledger app can’t do. Paste the target and calldata
            from the dApp or ABI tool you’re using.
          </p>
          <input className="input" placeholder="Contract (0x… or 0.0.…)" value={to}
                 onChange={(e) => setTo(e.target.value)} />
          <input className="input" placeholder="Value in HBAR (optional)" inputMode="decimal"
                 value={value} onChange={(e) => setValue(e.target.value)} />
          <input className="input mono" placeholder="Calldata (0x…)" value={data}
                 autoComplete="off" spellCheck={false}
                 onChange={(e) => setData(e.target.value)} />
          <p className="muted xsmall">
            Your Ledger will show “contract data” — if it asks, enable Blind
            signing in the Ethereum app’s settings, and only approve calls you
            built yourself. {network === "mainnet" ? "Mainnet — real funds." : ""}
          </p>
          <button className="btn primary" disabled={busy || !to} onClick={call}>
            {busy ? status || "Working…" : "Review on Ledger & execute"}
          </button>
        </>
      )}
      {msg && (
        <p className={msg.ok ? "success" : "error"}>
          {msg.text}{" "}
          {msg.url && <a className="link" href={msg.url} target="_blank" rel="noreferrer">View ↗</a>}
        </p>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
