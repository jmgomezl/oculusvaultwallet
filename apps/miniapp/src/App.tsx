import { useCallback, useEffect, useRef, useState } from "react";
import {
  OculusVault,
  isInsideTelegram,
  getStartParam,
  parsePayIntent,
  canScanQr,
  scanQr,
  haptic,
  type Balance,
  type HederaNetwork,
  type HistoryItem,
  type PayIntent,
  type WalletIdentity,
} from "@oculusvault/sdk";
import { authenticate, isDemoMode, type AuthResult } from "./api.js";
import { createWallet, DEFAULT_NETWORK } from "./walletFactory.js";
import { Qr } from "./Qr.js";
import { Landing } from "./Landing.js";

type Phase = "loading" | "error" | "locked" | "ready";

const NET_KEY = "oculusvault:network";
const MAINNET_ACK_KEY = "oculusvault:mainnetAck";

/** Demo (browser) is a testnet-only sandbox: without a verified Telegram
 * identity there is no real wallet to put real money in. */
function loadSavedNetwork(): HederaNetwork {
  if (isDemoMode()) return "testnet";
  try {
    const v = localStorage.getItem(NET_KEY);
    if (v === "mainnet" || v === "testnet") return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_NETWORK;
}

/** "5.00000000" → "5", "3.99875220" → "3.9987522" — friendlier amounts. */
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

/**
 * Router: inside Telegram, drop straight into the wallet. In a plain browser,
 * show the public landing page until the visitor chooses to launch the demo.
 * A pay deep-link (?startapp=pay_…) skips the landing too — someone following
 * a payment link wants the wallet, not marketing.
 */
export function App() {
  const [launched, setLaunched] = useState(
    () => isInsideTelegram() || parsePayIntent(getStartParam() ?? "") !== null,
  );
  if (!launched) return <Landing onLaunch={() => setLaunched(true)} />;
  return <WalletApp />;
}

function WalletApp() {
  const walletRef = useRef<OculusVault | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string>("");
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [identity, setIdentity] = useState<WalletIdentity | null>(null);
  const [network, setNetwork] = useState<HederaNetwork>(loadSavedNetwork);
  const [askMainnet, setAskMainnet] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const a = await authenticate();
        setAuth(a);
        walletRef.current = createWallet(loadSavedNetwork());
        const exists = await walletRef.current.hasWallet(a.userId);
        setIsNew(!exists);
        setPhase("locked");
      } catch (e) {
        setError((e as Error).message);
        setPhase("error");
      }
    })();
  }, []);

  const onUnlock = useCallback(
    async (password: string) => {
      if (!walletRef.current || !auth) return;
      const id = await walletRef.current.createOrRecoverWallet({
        userId: auth.userId,
        secret: { source: "password", value: password },
      });
      haptic("success");
      setIdentity(id);
      setPhase("ready");
    },
    [auth],
  );

  /** Same key = same address on every network, so switching is instant. */
  const doSwitch = useCallback(
    (n: HederaNetwork) => {
      walletRef.current?.switchNetwork(n);
      try {
        localStorage.setItem(NET_KEY, n);
      } catch {
        /* fine */
      }
      haptic("tap");
      setIdentity((id) => (id ? { ...id, hederaAccountId: null } : id));
      setNetwork(n);
    },
    [],
  );

  const requestSwitch = useCallback(
    (n: HederaNetwork) => {
      if (n === network) return;
      // No verified Telegram identity in a browser → no mainnet. The demo
      // stays a harmless testnet sandbox.
      if (n === "mainnet" && isDemoMode()) {
        haptic("warning");
        setAskMainnet(true); // shows the demo notice variant
        return;
      }
      let acked = false;
      try {
        acked = localStorage.getItem(MAINNET_ACK_KEY) === "yes";
      } catch {
        /* fine */
      }
      if (n === "mainnet" && !acked) {
        setAskMainnet(true);
        return;
      }
      doSwitch(n);
    },
    [network, doSwitch],
  );

  if (phase === "loading") return <Centered>Connecting…</Centered>;
  if (phase === "error")
    return (
      <Centered>
        <h2>Couldn’t start</h2>
        <p className="muted">{error}</p>
        <p className="muted small">
          Check your connection and reopen the Mini App from the bot.
        </p>
      </Centered>
    );
  if (phase === "locked")
    return (
      <UnlockScreen isNew={isNew} username={auth?.user.username} onUnlock={onUnlock} />
    );

  return (
    <>
      {askMainnet &&
        (isDemoMode() ? (
          <DemoMainnetNotice onClose={() => setAskMainnet(false)} />
        ) : (
          <MainnetGate
            onConfirm={() => {
              try {
                localStorage.setItem(MAINNET_ACK_KEY, "yes");
              } catch {
                /* fine */
              }
              setAskMainnet(false);
              doSwitch("mainnet");
            }}
            onCancel={() => setAskMainnet(false)}
          />
        ))}
      <Dashboard
        key={network} /* remount per network: fresh balance/history/pollers */
        wallet={walletRef.current!}
        identity={identity!}
        setIdentity={setIdentity}
        freshWallet={isNew}
        network={network}
        onSwitchNetwork={requestSwitch}
      />
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="app centered">{children}</div>;
}

/** Shown when a browser (demo) visitor taps Mainnet: the real wallet — and
 * real money — belongs to the Telegram identity, not this sandbox. */
function DemoMainnetNotice({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>Mainnet lives in Telegram</h2>
        <p className="muted small">
          You’re in the <strong>browser demo</strong> — a testnet sandbox whose
          keys exist only in this browser. Your <strong>real wallet</strong> is
          secured by your <strong>Telegram identity</strong>, so mainnet (real
          HBAR) is only available inside the Telegram Mini App.
        </p>
        <p className="muted small">
          Here you can do everything risk-free with testnet HBAR: receive,
          send, scan, export.
        </p>
        <button className="btn primary" onClick={onClose}>
          Got it — stay on testnet
        </button>
      </div>
    </div>
  );
}

/** One-time, plain-words gate before the first mainnet switch. */
function MainnetGate({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
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
      haptic("error");
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <Header network={loadSavedNetwork()} />
      <div className="card">
        <h2>
          {isNew
            ? isDemoMode()
              ? "Create a demo wallet"
              : "Create your wallet"
            : "Unlock your wallet"}
        </h2>
        <p className="muted small">
          {isNew
            ? isDemoMode()
              ? "A testnet sandbox that lives only in this browser. Pick a password — keys are encrypted locally and never leave this device."
              : "Pick a password. It encrypts your key on this device — we never see it, and it can’t be recovered if lost."
            : `Welcome back${username ? ", @" + username : ""}. Enter your password to unlock.`}
        </p>
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
          {busy ? "Working…" : isNew ? "Create wallet" : "Unlock"}
        </button>
        {isNew && (
          <p className="muted xsmall">
            🔒 Non-custodial: your private key is encrypted with Argon2id +
            XChaCha20-Poly1305 and stored as ciphertext only.
          </p>
        )}
      </div>
    </div>
  );
}

function Dashboard({
  wallet,
  identity,
  setIdentity,
  freshWallet,
  network,
  onSwitchNetwork,
}: {
  wallet: OculusVault;
  identity: WalletIdentity;
  setIdentity: (id: WalletIdentity | null) => void;
  freshWallet: boolean;
  network: HederaNetwork;
  onSwitchNetwork: (n: HederaNetwork) => void;
}) {
  // A pay deep-link (NFC tag / QR / t.me link) pre-fills the Send tab.
  const [intent] = useState<PayIntent | null>(() =>
    parsePayIntent(getStartParam() ?? ""),
  );
  const [balance, setBalance] = useState<Balance | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState<string>("");
  const [tab, setTab] = useState<"receive" | "send">(intent ? "send" : "receive");
  const [revealedKey, setRevealedKey] = useState("");
  const [backupDone, setBackupDone] = useState(false);

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
      haptic("success");
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

  const revealKey = async () => setRevealedKey(await wallet.exportKey());
  const usd = balance ? formatUsd(balance.usdEstimate) : null;

  return (
    <div className={network === "mainnet" ? "app on-mainnet" : "app"}>
      <Header network={network} onSwitch={onSwitchNetwork} />
      {toast && <div className="toast">🎉 {toast}</div>}

      {network === "mainnet" && (
        <div className="mainnet-strip">
          Real HBAR · beta, unaudited — keep small amounts
        </div>
      )}

      {isDemoMode() && (
        <div className="demo-strip">
          Browser demo · testnet sandbox — this wallet lives only in this
          browser. Your real wallet is in the Telegram app, unlocked by your
          Telegram identity.
        </div>
      )}

      {freshWallet && !backupDone && (
        <div className="banner">
          <div>
            <strong>Back up your key.</strong>
            <span className="muted small">
              {" "}If you lose your password there is no recovery — export your
              key once and store it somewhere safe.
            </span>
          </div>
          <div className="banner-actions">
            <button
              className="btn sm"
              onClick={() => {
                revealKey();
                setBackupDone(true);
              }}
            >
              Export now
            </button>
            <button className="btn ghost sm" onClick={() => setBackupDone(true)}>
              Later
            </button>
          </div>
        </div>
      )}

      <div className="card balance-card">
        <span className="muted small">Balance · {network}</span>
        <div className="balance">{balance ? formatHbar(balance.hbar) : "…"} ℏ</div>
        {usd && <span className="muted small usd">{usd}</span>}
        <a className="link small" href={wallet.accountUrl()} target="_blank" rel="noreferrer">
          {identity.hederaAccountId ?? "Account auto-creates on first deposit"} ↗
        </a>
      </div>

      <div className="tabs">
        <button className={tab === "receive" ? "tab active" : "tab"} onClick={() => setTab("receive")}>
          Receive
        </button>
        <button className={tab === "send" ? "tab active" : "tab"} onClick={() => setTab("send")}>
          Send
        </button>
      </div>

      {tab === "receive" ? (
        <ReceiveTab identity={identity} network={network} />
      ) : (
        <SendTab
          wallet={wallet}
          onSent={refresh}
          prefill={intent}
          balanceHbar={balance ? balance.hbar : null}
          network={network}
        />
      )}

      <HistoryList items={history} />
      <ExportRow keyText={revealedKey} onReveal={revealKey} onHide={() => setRevealedKey("")} />
      <Footer />
    </div>
  );
}

function ReceiveTab({
  identity,
  network,
}: {
  identity: WalletIdentity;
  network: HederaNetwork;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(identity.evmAddress).then(() => {
      haptic("tap");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="card center">
      <Qr value={identity.evmAddress} />
      <p className="muted small">Your address (EVM / Hedera alias)</p>
      <code className="addr" onClick={copy}>
        {identity.evmAddress}
      </code>
      <button className="btn" onClick={copy}>
        {copied ? "Copied!" : "Copy address"}
      </button>
      <p className="muted xsmall">
        Send {network} HBAR here. The first deposit auto-creates your Hedera
        account. Same address on every network.
      </p>
    </div>
  );
}

function SendTab({
  wallet,
  onSent,
  prefill,
  balanceHbar,
  network,
}: {
  wallet: OculusVault;
  onSent: () => void;
  prefill: PayIntent | null;
  balanceHbar: string | null;
  network: HederaNetwork;
}) {
  const [to, setTo] = useState(prefill?.to ?? "");
  const [amount, setAmount] = useState(prefill?.amountHbar ?? "");
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
    if (err) {
      haptic("warning");
      return setMsg({ ok: false, text: err });
    }
    setStage("confirm");
  };

  const scan = async () => {
    const text = await scanQr("Scan a wallet address or payment QR");
    if (!text) return;
    const intent = parsePayIntent(text);
    if (!intent) {
      haptic("warning");
      return setMsg({ ok: false, text: "That QR doesn’t contain a wallet address." });
    }
    haptic("tap");
    setMsg(null);
    setTo(intent.to);
    if (intent.amountHbar) setAmount(intent.amountHbar);
  };

  const send = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.send(to.trim(), amount.trim());
      haptic("success");
      setMsg({ ok: true, text: `Sent ${formatHbar(amount)} ℏ · ${r.status}`, url: r.hashscanUrl });
      setTo("");
      setAmount("");
      setStage("edit");
      onSent();
    } catch (e) {
      haptic("error");
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
            {network}
            {network === "mainnet" ? " — real HBAR" : ""}
          </span>
        </div>
        <p className="muted xsmall">
          Transfers are final. A small network fee (~0.001 ℏ) applies.
        </p>
        <button className="btn primary" disabled={busy} onClick={send}>
          {busy ? "Sending…" : "Confirm & send"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={() => setStage("edit")}>
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="input-row">
        <input
          className="input"
          placeholder="Recipient (0x… or 0.0.…)"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
        {!isDemoMode() && canScanQr() && (
          <button className="btn scan" onClick={scan} title="Scan a QR code">
            ⌗
          </button>
        )}
      </div>
      <input
        className="input"
        placeholder="Amount (HBAR)"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button className="btn primary" disabled={busy || !to || !amount} onClick={review}>
        Review transfer
      </button>
      {msg && (
        <p className={msg.ok ? "success" : "error"}>
          {msg.text}{" "}
          {msg.url && (
            <a className="link" href={msg.url} target="_blank" rel="noreferrer">
              View ↗
            </a>
          )}
        </p>
      )}
    </div>
  );
}

function HistoryList({ items }: { items: HistoryItem[] }) {
  return (
    <div className="card">
      <h3>History</h3>
      {items.length === 0 && <p className="muted small">No transactions yet.</p>}
      {items.map((it) => (
        <a
          key={it.transactionId + it.consensusTimestamp}
          className="row"
          href={it.hashscanUrl}
          target="_blank"
          rel="noreferrer"
        >
          <span className={it.direction === "in" ? "amt in" : "amt out"}>
            {it.direction === "in" ? "+" : ""}
            {formatHbar(it.amount)} ℏ
          </span>
          <span className="muted xsmall">
            {new Date(it.timestamp).toLocaleString()}
          </span>
          <span className="link xsmall">↗</span>
        </a>
      ))}
    </div>
  );
}

function ExportRow({
  keyText,
  onReveal,
  onHide,
}: {
  keyText: string;
  onReveal: () => void;
  onHide: () => void;
}) {
  return (
    <div className="card">
      <h3>Self-custody</h3>
      {!keyText ? (
        <button className="btn" onClick={onReveal}>
          Export private key
        </button>
      ) : (
        <>
          <p className="error xsmall">
            ⚠️ Anyone with this key controls the wallet. Never share it.
          </p>
          <code className="addr break">{keyText}</code>
          <button className="btn" onClick={() => navigator.clipboard.writeText(keyText)}>
            Copy key
          </button>
          <button className="btn ghost" onClick={onHide}>
            Hide
          </button>
        </>
      )}
    </div>
  );
}

function Header({
  network,
  onSwitch,
}: {
  network: HederaNetwork;
  onSwitch?: (n: HederaNetwork) => void;
}) {
  return (
    <header className="header">
      <span className="logo">
        ℏ OculusVault
        {isDemoMode() && <span className="demo-chip">DEMO</span>}
      </span>
      {onSwitch ? (
        <div className="netswitch" role="tablist" aria-label="Network">
          <button
            role="tab"
            aria-selected={network === "testnet"}
            className={network === "testnet" ? "seg active" : "seg"}
            onClick={() => onSwitch("testnet")}
          >
            Testnet
          </button>
          <button
            role="tab"
            aria-selected={network === "mainnet"}
            className={network === "mainnet" ? "seg active gold-seg" : "seg"}
            onClick={() => onSwitch("mainnet")}
          >
            Mainnet
          </button>
        </div>
      ) : (
        <span className={`net ${network}`}>{network}</span>
      )}
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer muted xsmall">
      Non-custodial · keys stay on your device · open-source (Apache-2.0)
    </footer>
  );
}
