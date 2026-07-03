import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  OculusVault,
  LocalEncryptedKeyProvider,
  RemoteVaultStorage,
  type Balance,
  type HederaNetwork,
  type HistoryItem,
  type WalletIdentity,
} from "@oculusvault/sdk";
import {
  getSession,
  clearSession,
  onSessionChange,
  openConnectTab,
  cacheKey,
  getCachedKey,
  dropCachedKey,
  type StoredSession,
} from "./ext.js";
import { Qr } from "./Qr.js";
import { Aperture } from "./Aperture.js";
import "../../miniapp/src/styles.css";
import "./popup.css";

const API_BASE = "https://api.oculusvault.com";
const NET_KEY = "ovext:network";
const MAINNET_ACK_KEY = "ovext:mainnetAck";

function loadSavedNetwork(): HederaNetwork {
  try {
    const v = localStorage.getItem(NET_KEY);
    if (v === "mainnet" || v === "testnet") return v;
  } catch { /* fine */ }
  return "testnet";
}

function formatHbar(hbar: string): string {
  if (!hbar.includes(".")) return hbar;
  return hbar.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
function formatUsd(usd: number | null): string | null {
  if (usd == null) return null;
  return `≈ $${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
}
function shortAddr(a: string): string {
  return a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
}
function isAuthError(e: unknown): boolean {
  return /\b401\b/.test(String((e as Error)?.message ?? e));
}

type Phase = "loading" | "connect" | "locked" | "ready";

function App() {
  const walletRef = useRef<OculusVault | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [session, setSession] = useState<StoredSession | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [identity, setIdentity] = useState<WalletIdentity | null>(null);
  const [network, setNetwork] = useState<HederaNetwork>(loadSavedNetwork);
  const [askMainnet, setAskMainnet] = useState(false);
  const [error, setError] = useState("");

  const boot = useCallback(async () => {
    setError("");
    const s = await getSession();
    if (!s) {
      setPhase("connect");
      return;
    }
    setSession(s);
    const wallet = new OculusVault({
      network: loadSavedNetwork(),
      keyProvider: new LocalEncryptedKeyProvider(
        new RemoteVaultStorage({ apiBase: API_BASE, getToken: () => s.token }),
      ),
    });
    walletRef.current = wallet;
    try {
      // Cached unlocked key from the last 15 minutes? Skip the password.
      const cached = await getCachedKey();
      if (cached) {
        const id = await wallet.unlockWithKey(cached.privateKeyHex, s.userId);
        setIdentity(id);
        setPhase("ready");
        return;
      }
      const exists = await wallet.hasWallet(s.userId);
      setIsNew(!exists);
      setPhase("locked");
    } catch (e) {
      if (isAuthError(e)) {
        await clearSession();
        setPhase("connect");
        return;
      }
      setError((e as Error).message);
      setPhase("connect");
    }
  }, []);

  useEffect(() => {
    boot();
    return onSessionChange(boot);
  }, [boot]);

  const onUnlock = useCallback(
    async (password: string) => {
      const wallet = walletRef.current;
      if (!wallet || !session) return;
      const id = await wallet.createOrRecoverWallet({
        userId: session.userId,
        secret: { source: "password", value: password },
      });
      await cacheKey(await wallet.exportKey(), wallet.network);
      setIdentity(id);
      setPhase("ready");
    },
    [session],
  );

  const doSwitch = useCallback((n: HederaNetwork) => {
    walletRef.current?.switchNetwork(n);
    try { localStorage.setItem(NET_KEY, n); } catch { /* fine */ }
    setIdentity((id) => (id ? { ...id, hederaAccountId: null } : id));
    setNetwork(n);
  }, []);

  const requestSwitch = useCallback(
    (n: HederaNetwork) => {
      if (n === network) return;
      let acked = false;
      try { acked = localStorage.getItem(MAINNET_ACK_KEY) === "yes"; } catch { /* fine */ }
      if (n === "mainnet" && !acked) return setAskMainnet(true);
      doSwitch(n);
    },
    [network, doSwitch],
  );

  const disconnect = useCallback(async () => {
    await dropCachedKey();
    await clearSession();
    walletRef.current?.lock();
    setIdentity(null);
    setPhase("connect");
  }, []);

  if (phase === "loading")
    return (
      <div className="app centered">
        <Aperture size={56} />
        <p className="muted">Opening your vault…</p>
      </div>
    );

  if (phase === "connect")
    return (
      <div className="app unlock">
        <div className="unlock-mark"><Aperture size={84} hero /></div>
        <h1 className="unlock-title">OculusVault</h1>
        <p className="muted small unlock-sub">
          Your wallet is anchored to your <strong>Telegram identity</strong> —
          the same vault as the Telegram Mini App, on your desktop. Connect to
          continue.
        </p>
        <div className="card">
          <button className="btn primary" onClick={openConnectTab}>
            Connect Telegram
          </button>
          <p className="muted xsmall">
            A tab opens on oculusvault.com with the official Telegram sign-in.
            Come back here when it says “Connected”.
          </p>
          {error && <p className="error">{error}</p>}
        </div>
        <p className="muted xsmall unlock-foot">
          Non-custodial · keys never leave your device
        </p>
      </div>
    );

  if (phase === "locked")
    return (
      <UnlockScreen
        isNew={isNew}
        username={session?.user?.username}
        onUnlock={onUnlock}
      />
    );

  return (
    <>
      {askMainnet && (
        <MainnetGate
          onConfirm={() => {
            try { localStorage.setItem(MAINNET_ACK_KEY, "yes"); } catch { /* fine */ }
            setAskMainnet(false);
            doSwitch("mainnet");
          }}
          onCancel={() => setAskMainnet(false)}
        />
      )}
      <Dashboard
        key={network}
        wallet={walletRef.current!}
        identity={identity!}
        setIdentity={setIdentity}
        network={network}
        onSwitchNetwork={requestSwitch}
        onDisconnect={disconnect}
      />
    </>
  );
}

function UnlockScreen({
  isNew,
  username,
  onUnlock,
}: {
  isNew: boolean;
  username?: string;
  onUnlock: (pw: string) => Promise<void>;
}) {
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    setErr("");
    if (pw.length < 8) return setErr("Use at least 8 characters.");
    if (isNew && pw !== confirm) return setErr("Passwords don’t match.");
    setBusy(true);
    try {
      await onUnlock(pw);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app unlock">
      <div className="unlock-mark"><Aperture size={72} hero /></div>
      <h1 className="unlock-title">{isNew ? "Create your vault" : "Welcome back"}</h1>
      <p className="muted small unlock-sub">
        {isNew
          ? "Pick a password. It encrypts your key on this device — we never see it, and it can’t be recovered if lost."
          : `${username ? "@" + username + " · " : ""}The same password you use in Telegram.`}
      </p>
      <div className="card">
        <input
          className="input"
          type="password"
          placeholder="Password"
          value={pw}
          autoFocus
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !isNew && submit()}
        />
        {isNew && (
          <input
            className="input"
            type="password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        )}
        {err && <p className="error">{err}</p>}
        <button className="btn primary" disabled={busy} onClick={submit}>
          {busy ? "Working…" : isNew ? "Create vault" : "Unlock"}
        </button>
      </div>
    </div>
  );
}

function MainnetGate({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>Switch to mainnet?</h2>
        <p className="muted small">
          Mainnet uses <strong className="gold">real HBAR with real value</strong>.
          Your address stays the same — but transfers are final and this beta
          hasn’t had a third-party audit yet.
        </p>
        <ul className="muted small checklist">
          <li>Keep only small amounts here for now</li>
          <li>Back up your key first (Self-custody → Export)</li>
          <li>Your testnet balance stays safe on testnet</li>
        </ul>
        <button className="btn gold" onClick={onConfirm}>
          I understand — switch to mainnet
        </button>
        <button className="btn ghost" onClick={onCancel}>
          Stay on testnet
        </button>
      </div>
    </div>
  );
}

function Dashboard({
  wallet,
  identity,
  setIdentity,
  network,
  onSwitchNetwork,
  onDisconnect,
}: {
  wallet: OculusVault;
  identity: WalletIdentity;
  setIdentity: (id: WalletIdentity | null) => void;
  network: HederaNetwork;
  onSwitchNetwork: (n: HederaNetwork) => void;
  onDisconnect: () => void;
}) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState("");
  const [tab, setTab] = useState<"receive" | "send">("receive");

  const refresh = useCallback(async () => {
    const [b, h, accountId] = await Promise.all([
      wallet.getBalance(),
      wallet.getHistory(),
      wallet.refreshAccountId(),
    ]);
    setBalance(b);
    setHistory(h);
    if (accountId !== identity.hederaAccountId) {
      setIdentity({ ...identity, hederaAccountId: accountId });
    }
  }, [wallet, identity, setIdentity]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 6000);
    const stop = wallet.onIncoming((t) => {
      setToast(`Received ${formatHbar(t.amount)} ℏ`);
      refresh();
      setTimeout(() => setToast(""), 4000);
    });
    return () => {
      clearInterval(poll);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const usd = balance ? formatUsd(balance.usdEstimate) : null;

  return (
    <div className={network === "mainnet" ? "app on-mainnet" : "app"}>
      <header className="header">
        <span className="logo"><Aperture size={22} /> OculusVault</span>
        <div className="netswitch" role="tablist" aria-label="Network">
          <button
            role="tab"
            aria-selected={network === "testnet"}
            className={network === "testnet" ? "seg active" : "seg"}
            onClick={() => onSwitchNetwork("testnet")}
          >
            Testnet
          </button>
          <button
            role="tab"
            aria-selected={network === "mainnet"}
            className={network === "mainnet" ? "seg active gold-seg" : "seg"}
            onClick={() => onSwitchNetwork("mainnet")}
          >
            Mainnet
          </button>
        </div>
      </header>
      {toast && <div className="toast">🎉 {toast}</div>}

      {network === "mainnet" && (
        <div className="mainnet-strip">
          Real HBAR · beta, unaudited — keep small amounts
        </div>
      )}

      <section className="balance-hero">
        <span className="balance-label">Balance · {network}</span>
        <div className="balance">{balance ? formatHbar(balance.hbar) : "…"} ℏ</div>
        {usd && <span className="muted small usd">{usd}</span>}
        <a className="acct-pill" href={wallet.accountUrl()} target="_blank" rel="noreferrer">
          {identity.hederaAccountId ?? "auto-creates on first deposit"} ↗
        </a>
      </section>

      <div className="tabs">
        <button className={tab === "receive" ? "tab active" : "tab"} onClick={() => setTab("receive")}>
          <span className="tab-glyph in">↓</span> Receive
        </button>
        <button className={tab === "send" ? "tab active" : "tab"} onClick={() => setTab("send")}>
          <span className="tab-glyph out">↑</span> Send
        </button>
      </div>

      {tab === "receive" ? (
        <div className="card center">
          <div className="qr-frame"><Qr value={identity.evmAddress} size={168} /></div>
          <code className="addr" onClick={() => navigator.clipboard.writeText(identity.evmAddress)}>
            {identity.evmAddress}
          </code>
          <button className="btn primary" onClick={() => navigator.clipboard.writeText(identity.evmAddress)}>
            Copy address
          </button>
          {network === "testnet" && (
            <a
              className="voucher"
              href="https://faucet.hedera.com"
              target="_blank"
              rel="noreferrer"
              onClick={() => navigator.clipboard.writeText(identity.evmAddress)}
            >
              <span className="voucher-tag">Free ℏ</span>
              <span className="voucher-text">
                Claim up to 100 testnet ℏ a day at the official Hedera faucet ↗
                — <strong>we copy your address as you click</strong>, just
                paste it there.
              </span>
            </a>
          )}
        </div>
      ) : (
        <SendTab wallet={wallet} onSent={refresh} balanceHbar={balance ? balance.hbar : null} network={network} />
      )}

      <div className="card">
        <h3>History</h3>
        {history.length === 0 && <p className="muted small">No transactions yet.</p>}
        {history.map((it) => (
          <a key={it.transactionId + it.consensusTimestamp} className="row" href={it.hashscanUrl} target="_blank" rel="noreferrer">
            <span className={it.direction === "in" ? "row-glyph in" : "row-glyph out"}>
              {it.direction === "in" ? "↓" : "↑"}
            </span>
            <span className={it.direction === "in" ? "amt in" : "amt out"}>
              {it.direction === "in" ? "+" : ""}
              {formatHbar(it.amount)} ℏ
            </span>
            <span className="muted xsmall row-when">{new Date(it.timestamp).toLocaleString()}</span>
            <span className="link xsmall">↗</span>
          </a>
        ))}
      </div>

      <ExportCard reveal={(pw) => wallet.exportKeyWithSecret({ source: "password", value: pw })} />

      <footer className="footer muted xsmall">
        Anchored to Telegram · non-custodial ·{" "}
        <button className="linklike" onClick={onDisconnect}>disconnect</button>
      </footer>
    </div>
  );
}

/** Password-gated key export for the extension (re-verifies before reveal). */
function ExportCard({ reveal }: { reveal: (password: string) => Promise<string> }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState("");
  const [keyText, setKeyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const reset = () => { setOpen(false); setPw(""); setKeyText(""); setErr(""); };
  const submit = async () => {
    setErr("");
    if (!pw) return;
    setBusy(true);
    try {
      setKeyText(await reveal(pw));
      setPw("");
    } catch (e) {
      setErr(/decrypt|match|wrong/i.test((e as Error).message) ? "Wrong password." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Self-custody</h3>
      {!open ? (
        <button className="btn" onClick={() => setOpen(true)}>Export private key</button>
      ) : !keyText ? (
        <>
          <p className="muted small">Confirm your password to reveal your private key.</p>
          <input
            className="input" type="password" placeholder="Password" value={pw} autoFocus
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {err && <p className="error">{err}</p>}
          <button className="btn primary" disabled={busy || !pw} onClick={submit}>
            {busy ? "Verifying…" : "Reveal key"}
          </button>
          <button className="btn ghost" disabled={busy} onClick={reset}>Cancel</button>
        </>
      ) : (
        <>
          <p className="error xsmall">⚠️ Anyone with this key controls the wallet. Never share it.</p>
          <code className="addr break">{keyText}</code>
          <button className="btn" onClick={() => navigator.clipboard.writeText(keyText)}>Copy key</button>
          <button className="btn ghost" onClick={reset}>Hide</button>
        </>
      )}
    </div>
  );
}

function SendTab({
  wallet,
  onSent,
  balanceHbar,
  network,
}: {
  wallet: OculusVault;
  onSent: () => void;
  balanceHbar: string | null;
  network: HederaNetwork;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<"edit" | "confirm">("edit");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const validate = (): string | null => {
    const t = to.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(t) && !/^0\.0\.[0-9]+$/.test(t)) {
      return "Recipient must be a 0x address or 0.0.x account id.";
    }
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return "Enter a positive HBAR amount.";
    if (balanceHbar != null && a > Number(balanceHbar)) {
      return `That’s more than your balance (${formatHbar(balanceHbar)} ℏ).`;
    }
    return null;
  };

  const review = () => {
    setMsg(null);
    const err = validate();
    if (err) return setMsg({ ok: false, text: err });
    setStage("confirm");
  };

  const send = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.send(to.trim(), amount.trim());
      setMsg({ ok: true, text: `Sent ${formatHbar(amount)} ℏ · ${r.status}`, url: r.hashscanUrl });
      setTo("");
      setAmount("");
      setStage("edit");
      onSent();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      setStage("edit");
    } finally {
      setBusy(false);
    }
  };

  if (stage === "confirm") {
    return (
      <div className="card">
        <h3>Confirm transfer</h3>
        <div className="confirm-row">
          <span className="muted small">Send</span>
          <span className="confirm-amt">{formatHbar(amount)} ℏ</span>
        </div>
        <div className="confirm-row">
          <span className="muted small">To</span>
          <code className="addr">{shortAddr(to.trim())}</code>
        </div>
        <div className="confirm-row">
          <span className="muted small">Network</span>
          <span className={network === "mainnet" ? "gold" : undefined}>
            {network}{network === "mainnet" ? " — real HBAR" : ""}
          </span>
        </div>
        <p className="muted xsmall">Transfers are final. A small network fee (~0.001 ℏ) applies.</p>
        <button className="btn primary" disabled={busy} onClick={send}>
          {busy ? "Sending…" : "Confirm & send"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => setStage("edit")}>Back</button>
      </div>
    );
  }

  return (
    <div className="card">
      <input className="input" placeholder="Recipient (0x… or 0.0.…)" value={to} onChange={(e) => setTo(e.target.value)} />
      <input className="input" placeholder="Amount (HBAR)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <button className="btn primary" disabled={busy || !to || !amount} onClick={review}>
        Review transfer
      </button>
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
