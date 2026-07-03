import { useCallback, useEffect, useRef, useState } from "react";
import {
  OculusVault,
  isInsideTelegram,
  getStartParam,
  parsePayIntent,
  canScanQr,
  scanQr,
  haptic,
  setTelegramBackButton,
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
import { Aperture } from "./Aperture.js";

type Phase = "loading" | "error" | "locked" | "ready";
type View = "home" | "receive" | "send";

const NET_KEY = "oculusvault:network";
const MAINNET_ACK_KEY = "oculusvault:mainnetAck";

/** Dev-only escape hatch: run the wallet UI in a browser for local
 * development/preview (`VITE_FORCE_WALLET=true` in .env.development).
 * Never set in production builds. */
const FORCE_WALLET = import.meta.env.VITE_FORCE_WALLET === "true";

function loadSavedNetwork(): HederaNetwork {
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
 * Router — one rule, no exceptions: the wallet exists only inside Telegram,
 * where a verified identity exists. Everything else sees the product page.
 */
export function App() {
  if (isInsideTelegram() || FORCE_WALLET) return <WalletApp />;
  return <Landing />;
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
  const doSwitch = useCallback((n: HederaNetwork) => {
    walletRef.current?.switchNetwork(n);
    try {
      localStorage.setItem(NET_KEY, n);
    } catch {
      /* fine */
    }
    haptic("tap");
    setIdentity((id) => (id ? { ...id, hederaAccountId: null } : id));
    setNetwork(n);
  }, []);

  const requestSwitch = useCallback(
    (n: HederaNetwork) => {
      if (n === network) return;
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

  if (phase === "loading")
    return (
      <Centered>
        <Aperture size={56} />
        <p className="muted">Opening your vault…</p>
      </Centered>
    );
  if (phase === "error")
    return (
      <Centered>
        <Aperture size={56} />
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
      {askMainnet && (
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
      )}
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
    <div className="app unlock">
      <div className="unlock-mark">
        <Aperture size={84} hero />
      </div>
      <h1 className="unlock-title">
        {isNew ? "Create your vault" : "Welcome back"}
      </h1>
      <p className="muted small unlock-sub">
        {isNew
          ? "Pick a password. It encrypts your key on this device — we never see it, and it can’t be recovered if lost."
          : `${username ? "@" + username + " · " : ""}Enter your password to unlock.`}
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
      {isNew && (
        <p className="muted xsmall unlock-foot">
          🔒 Non-custodial · Argon2id + XChaCha20-Poly1305 · ciphertext only
        </p>
      )}
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
  // A pay deep-link (NFC tag / QR / t.me link) jumps straight to Send.
  const [intent] = useState<PayIntent | null>(() =>
    parsePayIntent(getStartParam() ?? ""),
  );
  const [view, setView] = useState<View>(intent ? "send" : "home");
  const [balance, setBalance] = useState<Balance | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState<string>("");
  const [exportOpen, setExportOpen] = useState(false);
  const [backupDone, setBackupDone] = useState(false);
  const [copied, setCopied] = useState<string>("");

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

  // Telegram's native Back button drives sub-view navigation.
  useEffect(() => {
    return setTelegramBackButton(view !== "home", () => {
      haptic("tap");
      setView("home");
    });
  }, [view]);

  const copy = useCallback((text: string, tag: string) => {
    navigator.clipboard.writeText(text).then(() => {
      haptic("tap");
      setCopied(tag);
      setTimeout(() => setCopied(""), 1500);
    });
  }, []);

  const usd = balance ? formatUsd(balance.usdEstimate) : null;

  if (view === "receive") {
    return (
      <div className={network === "mainnet" ? "app on-mainnet" : "app"}>
        <ViewHead title="Receive" onBack={() => setView("home")} />
        <div className="card center">
          <div className="qr-frame">
            <Qr value={identity.evmAddress} />
          </div>
          <p className="muted small">
            Scan to pay this wallet — or share the address below. It works on
            every network.
          </p>
          <code className="addr" onClick={() => copy(identity.evmAddress, "evm")}>
            {identity.evmAddress}
          </code>
          <button className="btn primary" onClick={() => copy(identity.evmAddress, "evm")}>
            {copied === "evm" ? "Copied ✓" : "Copy address"}
          </button>
        </div>

        <div className="card">
          <h3>Hedera account Nº</h3>
          {identity.hederaAccountId ? (
            <>
              <div className="acct-row">
                <code className="addr" onClick={() => copy(identity.hederaAccountId!, "acct")}>
                  {identity.hederaAccountId}
                </code>
                <button className="btn sm" onClick={() => copy(identity.hederaAccountId!, "acct")}>
                  {copied === "acct" ? "✓" : "Copy"}
                </button>
              </div>
              <a className="link small" href={wallet.accountUrl()} target="_blank" rel="noreferrer">
                View on Hashscan ↗
              </a>
              <p className="muted xsmall">
                Use either identifier to receive — the 0x address and this
                account Nº are the same wallet.
              </p>
            </>
          ) : (
            <p className="muted small">
              <span className="pending-stamp">Pending</span> Your account
              number is minted by the network with your <strong>first
              deposit</strong> — send any amount of {network} HBAR to the
              address above and it appears here automatically. Account numbers
              are per-network: your {network === "mainnet" ? "testnet" : "mainnet"}{" "}
              Nº is separate and may already exist.
            </p>
          )}
        </div>

        {network === "testnet" && (
          <a
            className="voucher"
            href="https://faucet.hedera.com"
            target="_blank"
            rel="noreferrer"
            onClick={() => copy(identity.evmAddress, "evm")}
          >
            <span className="voucher-tag">Free ℏ</span>
            <span className="voucher-text">
              Claim up to 100 testnet ℏ a day at the official Hedera faucet ↗
              — <strong>we copy your address as you tap</strong>, just paste it
              there.
            </span>
          </a>
        )}
      </div>
    );
  }

  if (view === "send") {
    return (
      <div className={network === "mainnet" ? "app on-mainnet" : "app"}>
        <ViewHead title="Send" onBack={() => setView("home")} />
        <SendTab
          wallet={wallet}
          onSent={refresh}
          prefill={intent}
          balanceHbar={balance ? balance.hbar : null}
          network={network}
          accountReady={identity.hederaAccountId != null}
        />
      </div>
    );
  }

  return (
    <div className={network === "mainnet" ? "app on-mainnet" : "app"}>
      <Header network={network} onSwitch={onSwitchNetwork} />
      {toast && <div className="toast">🎉 {toast}</div>}

      {network === "mainnet" && (
        <div className="mainnet-strip">
          Real HBAR · beta, unaudited — keep small amounts
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
                setBackupDone(true);
                setExportOpen(true);
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

      <section className="balance-hero">
        <span className="balance-label">Balance · {network}</span>
        <div className="balance">{balance ? formatHbar(balance.hbar) : "…"} ℏ</div>
        {usd && <span className="muted small usd">{usd}</span>}
        <div className="id-row">
          <button className="chip" onClick={() => copy(identity.evmAddress, "evm")}>
            {copied === "evm" ? "copied ✓" : shortAddr(identity.evmAddress)}
          </button>
          {identity.hederaAccountId ? (
            <a className="chip" href={wallet.accountUrl()} target="_blank" rel="noreferrer">
              Nº {identity.hederaAccountId} ↗
            </a>
          ) : (
            <span className="chip chip-pending" title="Appears with your first deposit">
              Nº pending first deposit
            </span>
          )}
        </div>
      </section>

      <div className="tabs">
        <button className="tab" onClick={() => { haptic("tap"); setView("receive"); }}>
          <span className="tab-glyph in">↓</span> Receive
        </button>
        <button className="tab" onClick={() => { haptic("tap"); setView("send"); }}>
          <span className="tab-glyph out">↑</span> Send
        </button>
      </div>

      {balance != null && Number(balance.hbar) === 0 && network === "testnet" && (
        <a
          className="voucher"
          href="https://faucet.hedera.com"
          target="_blank"
          rel="noreferrer"
          onClick={() => copy(identity.evmAddress, "evm")}
        >
          <span className="voucher-tag">Free ℏ</span>
          <span className="voucher-text">
            Empty vault? Claim free testnet ℏ at the official faucet ↗ —{" "}
            <strong>we copy your address as you tap</strong>, just paste it
            there.
          </span>
        </a>
      )}

      <HistoryList items={history} />
      <ExportRow
        open={exportOpen}
        setOpen={setExportOpen}
        reveal={(pw) => wallet.exportKeyWithSecret({ source: "password", value: pw })}
      />
      <Footer />
    </div>
  );
}

/** Sub-view header: in-app back arrow (Telegram's native Back also works). */
function ViewHead({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="view-head">
      <button className="back-btn" onClick={onBack} aria-label="Back">
        ‹
      </button>
      <h2 className="view-title">{title}</h2>
      <span className="view-spacer" />
    </div>
  );
}

function SendTab({
  wallet,
  onSent,
  prefill,
  balanceHbar,
  network,
  accountReady,
}: {
  wallet: OculusVault;
  onSent: () => void;
  prefill: PayIntent | null;
  balanceHbar: string | null;
  network: HederaNetwork;
  accountReady: boolean;
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

  if (!accountReady) {
    return (
      <div className="card center">
        <p className="muted small">
          <span className="pending-stamp">Pending</span> Your wallet can’t send
          yet — it needs a first deposit to activate its Hedera account. Share
          your address from <strong>Receive</strong>
          {network === "testnet" ? " or claim free testnet ℏ from the faucet" : ""}
          , then come back.
        </p>
      </div>
    );
  }

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
          <span className={it.direction === "in" ? "row-glyph in" : "row-glyph out"}>
            {it.direction === "in" ? "↓" : "↑"}
          </span>
          <span className={it.direction === "in" ? "amt in" : "amt out"}>
            {it.direction === "in" ? "+" : ""}
            {formatHbar(it.amount)} ℏ
          </span>
          <span className="muted xsmall row-when">
            {new Date(it.timestamp).toLocaleString()}
          </span>
          <span className="link xsmall">↗</span>
        </a>
      ))}
    </div>
  );
}

/**
 * Self-custody export, password-gated. Revealing the raw key ALWAYS
 * re-verifies the password (re-decrypts the stored ciphertext) — the key is
 * never shown just because the session is unlocked.
 */
function ExportRow({
  open,
  setOpen,
  reveal,
}: {
  open: boolean;
  setOpen: (v: boolean) => void;
  reveal: (password: string) => Promise<string>;
}) {
  const [pw, setPw] = useState("");
  const [keyText, setKeyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setOpen(false);
    setPw("");
    setKeyText("");
    setErr("");
  };

  const submit = async () => {
    setErr("");
    if (!pw) return;
    setBusy(true);
    try {
      const k = await reveal(pw);
      haptic("success");
      setKeyText(k);
      setPw("");
    } catch (e) {
      haptic("error");
      setErr(
        /decrypt|match|wrong/i.test((e as Error).message)
          ? "Wrong password."
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Self-custody</h3>
      {!open ? (
        <button className="btn" onClick={() => setOpen(true)}>
          Export private key
        </button>
      ) : !keyText ? (
        <>
          <p className="muted small">
            Confirm your password to reveal your private key.
          </p>
          <input
            className="input"
            type="password"
            placeholder="Password"
            value={pw}
            autoFocus
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          {err && <p className="error">{err}</p>}
          <button className="btn primary" disabled={busy || !pw} onClick={submit}>
            {busy ? "Verifying…" : "Reveal key"}
          </button>
          <button className="btn ghost" disabled={busy} onClick={reset}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <p className="error xsmall">
            ⚠️ Anyone with this key controls the wallet. Never share it.
          </p>
          <code className="addr break">{keyText}</code>
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard.writeText(keyText);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Copied ✓" : "Copy key"}
          </button>
          <button className="btn ghost" onClick={reset}>
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
        <Aperture size={22} /> OculusVault
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
