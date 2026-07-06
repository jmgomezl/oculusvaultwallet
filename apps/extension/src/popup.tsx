import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  OculusVault,
  LocalEncryptedKeyProvider,
  RemoteVaultStorage,
  buildPayLink,
  fromPrivateKey,
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
/** Bot behind t.me pay/request links — same links the Mini App produces. */
const BOT = "oculusvaultbot";

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
  const [recovering, setRecovering] = useState(false);
  const [storedAddr, setStoredAddr] = useState<string | null>(null);
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

  const startRecover = useCallback(async () => {
    const wallet = walletRef.current;
    if (!wallet || !session) return;
    setStoredAddr(await wallet.storedAddress(session.userId));
    setRecovering(true);
  }, [session]);

  const onRestore = useCallback(
    async (privateKeyHex: string, newPassword: string) => {
      const wallet = walletRef.current;
      if (!wallet || !session) return;
      const id = await wallet.importWallet({
        userId: session.userId,
        privateKeyHex,
        secret: { source: "password", value: newPassword },
      });
      await cacheKey(await wallet.exportKey(), wallet.network);
      setIdentity(id);
      setRecovering(false);
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

  if (phase === "locked") {
    if (recovering)
      return (
        <RecoverScreen
          existingAddress={storedAddr}
          onRestore={onRestore}
          onBack={() => setRecovering(false)}
        />
      );
    return (
      <UnlockScreen
        isNew={isNew}
        username={session?.user?.username}
        onUnlock={onUnlock}
        onRecover={startRecover}
      />
    );
  }

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
        freshWallet={isNew}
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
  onRecover,
}: {
  isNew: boolean;
  username?: string;
  onUnlock: (pw: string) => Promise<void>;
  onRecover: () => void;
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
        <button className="linklike unlock-recover" onClick={onRecover}>
          {isNew
            ? "Already have a key? Import it instead"
            : "Forgot password? Restore from your backed-up key"}
        </button>
      </div>
    </div>
  );
}

/**
 * Forgot-password recovery / key import — same flow as the Mini App. The
 * pasted key's address is derived live so the user can confirm it's the right
 * wallet BEFORE anything is written; replacing a different stored wallet
 * requires an explicit opt-in.
 */
function RecoverScreen({
  existingAddress,
  onRestore,
  onBack,
}: {
  existingAddress: string | null;
  onRestore: (privateKeyHex: string, newPassword: string) => Promise<void>;
  onBack: () => void;
}) {
  const [keyIn, setKeyIn] = useState("");
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [replaceOk, setReplaceOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const cleaned = keyIn.trim().replace(/^0x/i, "");
  const validKey = /^[0-9a-fA-F]{64}$/.test(cleaned);
  let derived: string | null = null;
  if (validKey) {
    try {
      derived = fromPrivateKey(cleaned).evmAddress;
    } catch {
      derived = null;
    }
  }
  const mismatch =
    derived != null &&
    existingAddress != null &&
    derived.toLowerCase() !== existingAddress.toLowerCase();

  const submit = async () => {
    setErr("");
    if (!derived) return setErr("Paste your 64-character private key (with or without 0x).");
    if (pw.length < 8) return setErr("Use at least 8 characters for the new password.");
    if (pw !== confirm) return setErr("Passwords don’t match.");
    if (mismatch && !replaceOk) {
      return setErr("Confirm the replacement checkbox to continue.");
    }
    setBusy(true);
    try {
      await onRestore(cleaned, pw);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app unlock">
      <div className="unlock-mark"><Aperture size={72} hero /></div>
      <h1 className="unlock-title">Restore your vault</h1>
      <p className="muted small unlock-sub">
        Paste the private key you backed up. It never leaves this device — we
        re-encrypt it with a new password of your choice.
      </p>
      <div className="card">
        <input
          className="input mono"
          placeholder="Private key (64 hex characters)"
          value={keyIn}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setKeyIn(e.target.value)}
        />
        {derived && (
          <p className={mismatch ? "error xsmall" : "success xsmall"}>
            {mismatch ? (
              <>
                ⚠️ This key belongs to <code>{shortAddr(derived)}</code> — but
                your stored vault is <code>{shortAddr(existingAddress!)}</code>.
                Restoring will REPLACE the stored wallet.
              </>
            ) : (
              <>✓ Key recognised — wallet {shortAddr(derived)}</>
            )}
          </p>
        )}
        {mismatch && (
          <label className="replace-check">
            <input
              type="checkbox"
              checked={replaceOk}
              onChange={(e) => setReplaceOk(e.target.checked)}
            />
            <span>
              I understand this replaces the stored wallet. Without its key or
              password, the old wallet becomes unrecoverable.
            </span>
          </label>
        )}
        <input
          className="input"
          type="password"
          placeholder="New password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="Confirm new password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        {err && <p className="error">{err}</p>}
        <button
          className="btn primary"
          disabled={busy || !validKey || !pw || !confirm}
          onClick={submit}
        >
          {busy ? "Restoring…" : "Restore vault"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
      <p className="muted xsmall unlock-foot">
        🔒 The key is encrypted on-device · only ciphertext is stored
      </p>
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
  freshWallet,
  network,
  onSwitchNetwork,
  onDisconnect,
}: {
  wallet: OculusVault;
  identity: WalletIdentity;
  setIdentity: (id: WalletIdentity | null) => void;
  freshWallet: boolean;
  network: HederaNetwork;
  onSwitchNetwork: (n: HederaNetwork) => void;
  onDisconnect: () => void;
}) {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState("");
  const [tab, setTab] = useState<"receive" | "send">("receive");
  const [exportOpen, setExportOpen] = useState(false);
  const [backupDone, setBackupDone] = useState(false);
  const [copied, setCopied] = useState("");
  const [reqAmount, setReqAmount] = useState("");
  const [requestMode, setRequestMode] = useState(false);

  const copy = useCallback((text: string, tag: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(tag);
      setTimeout(() => setCopied(""), 1500);
    });
  }, []);

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

      {freshWallet && !backupDone && (
        <div className="banner">
          <div>
            <strong>Back up your key.</strong>
            <span className="muted small">
              {" "}Your backed-up key is the ONLY way back in if you forget
              your password — export it once and store it somewhere safe.
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
        <ReceiveTab
          wallet={wallet}
          identity={identity}
          network={network}
          copied={copied}
          copy={copy}
          reqAmount={reqAmount}
          setReqAmount={setReqAmount}
          requestMode={requestMode}
          setRequestMode={setRequestMode}
        />
      ) : (
        <SendTab
          wallet={wallet}
          onSent={refresh}
          balanceHbar={balance ? balance.hbar : null}
          network={network}
          accountReady={identity.hederaAccountId != null}
        />
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

      <ExportCard
        open={exportOpen}
        setOpen={setExportOpen}
        reveal={(pw) => wallet.exportKeyWithSecret({ source: "password", value: pw })}
      />

      <footer className="footer muted xsmall">
        Anchored to Telegram · non-custodial ·{" "}
        <button className="linklike" onClick={onDisconnect}>disconnect</button>
      </footer>
    </div>
  );
}

/** Receive: QR + address, request-a-payment link builder, Hedera account Nº. */
function ReceiveTab({
  wallet,
  identity,
  network,
  copied,
  copy,
  reqAmount,
  setReqAmount,
  requestMode,
  setRequestMode,
}: {
  wallet: OculusVault;
  identity: WalletIdentity;
  network: HederaNetwork;
  copied: string;
  copy: (text: string, tag: string) => void;
  reqAmount: string;
  setReqAmount: (v: string) => void;
  requestMode: boolean;
  setRequestMode: (v: boolean) => void;
}) {
  const requestLink = buildPayLink(
    BOT,
    identity.evmAddress,
    reqAmount && Number(reqAmount) > 0 ? reqAmount : undefined,
  );
  const requesting = requestMode && requestLink != null;

  return (
    <>
      <div className="card center">
        <div className="qr-frame">
          <Qr value={requesting ? requestLink : identity.evmAddress} size={168} />
        </div>
        {requesting ? (
          <p className="muted small">
            <strong className="req-live">
              Requesting{reqAmount && Number(reqAmount) > 0 ? ` ${formatHbar(reqAmount)} ℏ` : " payment"}
            </strong>{" "}
            — anyone scanning this with their camera lands in OculusVault with
            your details pre-filled.{" "}
            <button className="linklike" onClick={() => setRequestMode(false)}>
              Show plain address instead
            </button>
          </p>
        ) : (
          <p className="muted small">
            Scan to pay this wallet — or share the address below. It works on
            every network.
          </p>
        )}
        <code className="addr" onClick={() => copy(identity.evmAddress, "evm")}>
          {identity.evmAddress}
        </code>
        <button className="btn primary" onClick={() => copy(identity.evmAddress, "evm")}>
          {copied === "evm" ? "Copied ✓" : "Copy address"}
        </button>
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
              — <strong>we copy your address as you click</strong>, just
              paste it there.
            </span>
          </a>
        )}
      </div>

      <div className="card">
        <h3>Request a payment</h3>
        <p className="muted small">
          Send someone a link that opens OculusVault with your details
          pre-filled — they just confirm.
        </p>
        <input
          className="input"
          placeholder="Amount in HBAR (optional)"
          inputMode="decimal"
          value={reqAmount}
          onChange={(e) => {
            setReqAmount(e.target.value);
            setRequestMode(true);
          }}
          onFocus={() => setRequestMode(true)}
        />
        <div className="req-actions">
          <button
            className="btn primary"
            onClick={() => {
              const label =
                reqAmount && Number(reqAmount) > 0
                  ? `Pay me ${formatHbar(reqAmount)} ℏ with OculusVault`
                  : "Pay me with OculusVault";
              window.open(
                `https://t.me/share/url?url=${encodeURIComponent(requestLink)}&text=${encodeURIComponent(label)}`,
                "_blank",
              );
            }}
          >
            Share in Telegram
          </button>
          <button className="btn" onClick={() => copy(requestLink, "reqlink")}>
            {copied === "reqlink" ? "Copied ✓" : "Copy link"}
          </button>
        </div>
        <code className="addr req-preview" onClick={() => copy(requestLink, "reqlink")}>
          {requestLink}
        </code>
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
            <span className="pending-stamp">Pending</span> Your account number
            is minted by the network with your <strong>first deposit</strong> —
            send any amount of {network} HBAR to the address above and it
            appears here automatically. Account numbers are per-network: your{" "}
            {network === "mainnet" ? "testnet" : "mainnet"} Nº is separate and
            may already exist.
          </p>
        )}
      </div>
    </>
  );
}

/** Password-gated key export for the extension (re-verifies before reveal). */
function ExportCard({
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
  accountReady,
}: {
  wallet: OculusVault;
  onSent: () => void;
  balanceHbar: string | null;
  network: HederaNetwork;
  accountReady: boolean;
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
