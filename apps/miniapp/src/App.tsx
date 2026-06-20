import { useCallback, useEffect, useRef, useState } from "react";
import {
  HederaWallet,
  type Balance,
  type HistoryItem,
  type WalletIdentity,
} from "@oculusvault/sdk";
import { authenticate, type AuthResult } from "./api.js";
import { createWallet, NETWORK_NAME } from "./walletFactory.js";
import { Qr } from "./Qr.js";

type Phase = "loading" | "error" | "locked" | "ready";

export function App() {
  const walletRef = useRef<HederaWallet | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string>("");
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [identity, setIdentity] = useState<WalletIdentity | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const a = await authenticate();
        setAuth(a);
        walletRef.current = createWallet();
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
      setIdentity(id);
      setPhase("ready");
    },
    [auth],
  );

  if (phase === "loading") return <Centered>Connecting…</Centered>;
  if (phase === "error")
    return (
      <Centered>
        <h2>Couldn’t start</h2>
        <p className="muted">{error}</p>
        <p className="muted small">
          Outside Telegram? Run the server with <code>ALLOW_DEV_AUTH=true</code>.
        </p>
      </Centered>
    );
  if (phase === "locked")
    return (
      <UnlockScreen isNew={isNew} username={auth?.user.username} onUnlock={onUnlock} />
    );

  return (
    <Dashboard wallet={walletRef.current!} identity={identity!} setIdentity={setIdentity} />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="app centered">{children}</div>;
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
    <div className="app">
      <Header />
      <div className="card">
        <h2>{isNew ? "Create your wallet" : "Unlock your wallet"}</h2>
        <p className="muted small">
          {isNew
            ? "Pick a password. It encrypts your key on this device — we never see it, and it can’t be recovered if lost."
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
}: {
  wallet: HederaWallet;
  identity: WalletIdentity;
  setIdentity: (id: WalletIdentity) => void;
}) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState<string>("");
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
      setToast(`Received ${t.amount} ℏ`);
      refresh();
      setTimeout(() => setToast(""), 4000);
    });
    return () => {
      clearInterval(poll);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app">
      <Header />
      {toast && <div className="toast">🎉 {toast}</div>}

      <div className="card balance-card">
        <span className="muted small">Balance</span>
        <div className="balance">{balance ? balance.hbar : "…"} ℏ</div>
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
        <ReceiveTab identity={identity} />
      ) : (
        <SendTab wallet={wallet} onSent={refresh} />
      )}

      <HistoryList items={history} />
      <ExportRow wallet={wallet} />
      <Footer />
    </div>
  );
}

function ReceiveTab({ identity }: { identity: WalletIdentity }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(identity.evmAddress).then(() => {
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
        Send testnet HBAR here. The first deposit auto-creates your Hedera account.
      </p>
    </div>
  );
}

function SendTab({ wallet, onSent }: { wallet: HederaWallet; onSent: () => void }) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const send = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.send(to.trim(), amount.trim());
      setMsg({ ok: true, text: `Sent! ${r.status}`, url: r.hashscanUrl });
      setTo("");
      setAmount("");
      onSent();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <input
        className="input"
        placeholder="Recipient (0x… or 0.0.…)"
        value={to}
        onChange={(e) => setTo(e.target.value)}
      />
      <input
        className="input"
        placeholder="Amount (HBAR)"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <button className="btn primary" disabled={busy || !to || !amount} onClick={send}>
        {busy ? "Sending…" : "Send HBAR"}
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
            {it.amount} ℏ
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

function ExportRow({ wallet }: { wallet: HederaWallet }) {
  const [key, setKey] = useState<string>("");
  const reveal = async () => setKey(await wallet.exportKey());
  return (
    <div className="card">
      <h3>Self-custody</h3>
      {!key ? (
        <button className="btn" onClick={reveal}>
          Export private key
        </button>
      ) : (
        <>
          <p className="error xsmall">
            ⚠️ Anyone with this key controls the wallet. Never share it.
          </p>
          <code className="addr break">{key}</code>
          <button className="btn" onClick={() => navigator.clipboard.writeText(key)}>
            Copy key
          </button>
          <button className="btn ghost" onClick={() => setKey("")}>
            Hide
          </button>
        </>
      )}
    </div>
  );
}

function Header() {
  return (
    <header className="header">
      <span className="logo">ℏ OculusVault</span>
      <span className={`net ${NETWORK_NAME}`}>{NETWORK_NAME}</span>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer muted xsmall">
      Non-custodial · keys stay on your device · open-source (MIT)
    </footer>
  );
}
