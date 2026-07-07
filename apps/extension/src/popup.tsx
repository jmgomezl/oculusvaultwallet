import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  OculusVault,
  LocalEncryptedKeyProvider,
  RemoteVaultStorage,
  buildPayLink,
  fromPrivateKey,
  USDC_TOKEN_IDS,
  type Balance,
  type HederaNetwork,
  type HistoryItem,
  type NetworkNode,
  type NftItem,
  type StakingInfo,
  type TokenBalance,
  type TokenInfo,
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

/** Recent send recipients, per network, most-recent-first, max 5. */
const recentsKey = (net: HederaNetwork) => `ovext:recents:${net}`;
function loadRecents(net: HederaNetwork): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentsKey(net)) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function pushRecent(net: HederaNetwork, addr: string): void {
  try {
    const list = [addr, ...loadRecents(net).filter((a) => a !== addr)].slice(0, 5);
    localStorage.setItem(recentsKey(net), JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
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
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [nfts, setNfts] = useState<NftItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState("");
  const [tab, setTab] = useState<"receive" | "send">("receive");
  const [exportOpen, setExportOpen] = useState(false);
  const [backupDone, setBackupDone] = useState(false);
  const [copied, setCopied] = useState("");
  const [reqAmount, setReqAmount] = useState("");
  const [reqAsset, setReqAsset] = useState("hbar");
  const [requestMode, setRequestMode] = useState(false);

  const copy = useCallback((text: string, tag: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(tag);
      setTimeout(() => setCopied(""), 1500);
    });
  }, []);

  const refresh = useCallback(async () => {
    const [b, h, t, n, accountId] = await Promise.all([
      wallet.getBalance(),
      wallet.getHistory(),
      wallet.getTokenBalances().catch(() => [] as TokenBalance[]),
      wallet.getNfts().catch(() => [] as NftItem[]),
      wallet.refreshAccountId(),
    ]);
    setBalance(b);
    setHistory(h);
    setTokens(t);
    setNfts(n);
    if (accountId !== identity.hederaAccountId) {
      setIdentity({ ...identity, hederaAccountId: accountId });
    }
  }, [wallet, identity, setIdentity]);

  useEffect(() => {
    refresh();
    const poll = setInterval(refresh, 6000);
    const stop = wallet.onIncoming((t) => {
      setToast(
        t.token
          ? `Received ${t.amount} ${t.token.symbol}`
          : `Received ${formatHbar(t.amount)} ℏ`,
      );
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
          tokens={tokens}
          copied={copied}
          copy={copy}
          reqAmount={reqAmount}
          setReqAmount={setReqAmount}
          reqAsset={reqAsset}
          setReqAsset={setReqAsset}
          requestMode={requestMode}
          setRequestMode={setRequestMode}
        />
      ) : (
        <SendTab
          wallet={wallet}
          onSent={refresh}
          balanceHbar={balance ? balance.hbar : null}
          tokens={tokens}
          network={network}
          accountReady={identity.hederaAccountId != null}
        />
      )}

      <TokensCard
        wallet={wallet}
        tokens={tokens}
        network={network}
        accountReady={identity.hederaAccountId != null}
        onChanged={refresh}
      />

      <StakeCard
        wallet={wallet}
        accountReady={identity.hederaAccountId != null}
      />

      {nfts.length > 0 && <NftCard nfts={nfts} wallet={wallet} onChanged={refresh} />}

      <HistoryList items={history} />

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
  tokens,
  copied,
  copy,
  reqAmount,
  setReqAmount,
  reqAsset,
  setReqAsset,
  requestMode,
  setRequestMode,
}: {
  wallet: OculusVault;
  identity: WalletIdentity;
  network: HederaNetwork;
  tokens: TokenBalance[];
  copied: string;
  copy: (text: string, tag: string) => void;
  reqAmount: string;
  setReqAmount: (v: string) => void;
  reqAsset: string;
  setReqAsset: (v: string) => void;
  requestMode: boolean;
  setRequestMode: (v: boolean) => void;
}) {
  const reqToken = tokens.find((t) => t.tokenId === reqAsset) ?? null;
  const reqUnit = reqToken ? reqToken.symbol : "ℏ";
  const requestLink = buildPayLink(
    BOT,
    identity.evmAddress,
    reqAmount && Number(reqAmount) > 0 ? reqAmount : undefined,
    reqToken ? reqToken.tokenId : undefined,
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
              Requesting
              {reqAmount && Number(reqAmount) > 0
                ? ` ${reqToken ? reqAmount : formatHbar(reqAmount)} ${reqUnit}`
                : reqToken
                  ? ` ${reqToken.symbol}`
                  : " payment"}
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
        {network === "mainnet" && (
          <a
            className="voucher"
            href="https://www.moonpay.com/buy/hbar"
            target="_blank"
            rel="noreferrer"
            onClick={() => copy(identity.evmAddress, "evm")}
          >
            <span className="voucher-tag">Buy ℏ</span>
            <span className="voucher-text">
              Top up with a card via MoonPay ↗ — an independent third-party
              on-ramp. <strong>We copy your address as you click</strong>;
              paste it as the destination wallet there.
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
        {tokens.length > 0 && (
          <select
            className="input"
            value={reqAsset}
            aria-label="Asset to request"
            onChange={(e) => {
              setReqAsset(e.target.value);
              setRequestMode(true);
            }}
          >
            <option value="hbar">HBAR (ℏ)</option>
            {tokens.map((t) => (
              <option key={t.tokenId} value={t.tokenId}>
                {t.symbol} — {t.name}
              </option>
            ))}
          </select>
        )}
        <input
          className="input"
          placeholder={`Amount in ${reqToken ? reqToken.symbol : "HBAR"} (optional)`}
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
                  ? `Pay me ${reqToken ? reqAmount : formatHbar(reqAmount)} ${reqUnit} with OculusVault`
                  : reqToken
                    ? `Pay me ${reqToken.symbol} with OculusVault`
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

/**
 * HTS tokens the wallet holds, plus the opt-in flow (association) — same
 * card as the Mini App: one-tap for USDC, paste-the-id for anything else.
 */
function TokensCard({
  wallet,
  tokens,
  network,
  accountReady,
  onChanged,
}: {
  wallet: OculusVault;
  tokens: TokenBalance[];
  network: HederaNetwork;
  accountReady: boolean;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [tokenIdIn, setTokenIdIn] = useState("");
  const [preview, setPreview] = useState<TokenInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const usdcId = USDC_TOKEN_IDS[network];
  const hasUsdc = usdcId != null && tokens.some((t) => t.tokenId === usdcId);
  const validId = /^0\.0\.\d+$/.test(tokenIdIn.trim());

  const lookup = async () => {
    setMsg(null);
    setPreview(null);
    setBusy(true);
    try {
      const info = await wallet.getTokenInfo(tokenIdIn.trim());
      if (info.type !== "FUNGIBLE_COMMON") {
        setMsg({ ok: false, text: "That token isn’t a fungible token — NFTs aren’t supported here." });
      } else {
        setPreview(info);
      }
    } catch {
      setMsg({ ok: false, text: `No token ${tokenIdIn.trim()} on ${network}.` });
    } finally {
      setBusy(false);
    }
  };

  const associate = async (tokenId: string, label: string) => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.associateToken(tokenId);
      setMsg({ ok: true, text: `${label} enabled · ${r.status}`, url: r.hashscanUrl });
      setPreview(null);
      setTokenIdIn("");
      setAdding(false);
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Tokens</h3>
      {tokens.length === 0 && (
        <p className="muted small">
          No tokens yet. Hedera tokens (like USDC) need a one-time opt-in
          before you can receive them — enabling one costs a tiny HBAR fee.
        </p>
      )}
      {tokens.map((t) => (
        <div className="acct-row" key={t.tokenId}>
          <span>
            <strong>{t.symbol}</strong>{" "}
            <span className="muted xsmall">{t.name}</span>
          </span>
          <span className="amt">
            {t.balance}
            {t.usdEstimate != null && (
              <span className="muted xsmall"> {formatUsd(t.usdEstimate)}</span>
            )}
          </span>
        </div>
      ))}
      {!accountReady ? (
        <p className="muted xsmall">
          <span className="pending-stamp">Pending</span> Tokens unlock once
          your account exists — receive any HBAR first.
        </p>
      ) : (
        <>
          <div className="req-actions">
            {usdcId && !hasUsdc && (
              <button
                className="btn"
                disabled={busy}
                onClick={() => associate(usdcId, "USDC")}
              >
                Enable USDC
              </button>
            )}
            {!adding && (
              <button className="btn ghost" disabled={busy} onClick={() => setAdding(true)}>
                Add by token ID
              </button>
            )}
          </div>
          {adding && (
            <>
              <div className="input-row">
                <input
                  className="input"
                  placeholder="Token ID (0.0.…)"
                  value={tokenIdIn}
                  onChange={(e) => {
                    setTokenIdIn(e.target.value);
                    setPreview(null);
                  }}
                  onKeyDown={(e) => e.key === "Enter" && validId && lookup()}
                />
                <button className="btn" disabled={busy || !validId} onClick={lookup}>
                  Check
                </button>
              </div>
              {preview && (
                <>
                  <p className="success xsmall">
                    ✓ {preview.name} ({preview.symbol}) · {preview.decimals} decimals
                  </p>
                  <button
                    className="btn primary"
                    disabled={busy}
                    onClick={() => associate(preview.tokenId, preview.symbol)}
                  >
                    {busy ? "Enabling…" : `Enable ${preview.symbol} (small ℏ fee)`}
                  </button>
                </>
              )}
              <button
                className="linklike"
                disabled={busy}
                onClick={() => {
                  setAdding(false);
                  setTokenIdIn("");
                  setPreview(null);
                  setMsg(null);
                }}
              >
                Cancel
              </button>
            </>
          )}
        </>
      )}
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

/** Collectibles — what you hold, with proof one tap away, and a per-serial
 * send flow (confirm-gated; transfers are final). */
function NftCard({
  nfts,
  wallet,
  onChanged,
}: {
  nfts: NftItem[];
  wallet: OculusVault;
  onChanged: () => void;
}) {
  const [sending, setSending] = useState<NftItem | null>(null);
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const validTo = /^0x[0-9a-fA-F]{40}$/.test(to.trim()) || /^0\.0\.[0-9]+$/.test(to.trim());

  const send = async () => {
    if (!sending) return;
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.sendNft(sending.tokenId, sending.serialNumber, to.trim());
      setMsg({
        ok: true,
        text: `Sent ${sending.name} #${sending.serialNumber} · ${r.status}`,
        url: r.hashscanUrl,
      });
      setSending(null);
      setTo("");
      onChanged();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Collectibles</h3>
      {nfts.map((n) => (
        <div className="row" key={`${n.tokenId}/${n.serialNumber}`}>
          <span className="row-glyph in">✦</span>
          <span>
            <strong>{n.name}</strong>{" "}
            <span className="muted xsmall">
              {n.symbol && `${n.symbol} · `}#{n.serialNumber}
            </span>
          </span>
          <span className="muted xsmall row-when">{n.tokenId}</span>
          <button
            className="btn sm"
            disabled={busy}
            onClick={() => {
              setMsg(null);
              setTo("");
              setSending(sending?.tokenId === n.tokenId && sending.serialNumber === n.serialNumber ? null : n);
            }}
          >
            Send
          </button>
          <a className="link xsmall" href={n.hashscanUrl} target="_blank" rel="noreferrer">
            ↗
          </a>
        </div>
      ))}
      {sending && (
        <>
          <p className="muted small">
            Sending <strong>{sending.name} #{sending.serialNumber}</strong>.
            The recipient must have this collection enabled (most wallets
            auto-accept). Transfers are final.
          </p>
          <input
            className="input"
            placeholder="Recipient (0x… or 0.0.…)"
            value={to}
            autoFocus
            onChange={(e) => setTo(e.target.value)}
          />
          <button className="btn primary" disabled={busy || !validTo} onClick={send}>
            {busy ? "Sending…" : `Send #${sending.serialNumber} — final`}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setSending(null)}>
            Cancel
          </button>
        </>
      )}
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
  const [detail, setDetail] = useState<HistoryItem | null>(null);
  return (
    <div className="card">
      <h3>History</h3>
      {items.length === 0 && <p className="muted small">No transactions yet.</p>}
      {items.map((it) => (
        <button
          key={it.transactionId + it.consensusTimestamp + (it.token?.tokenId ?? "")}
          className="row"
          onClick={() => setDetail(it)}
        >
          <span className={it.direction === "in" ? "row-glyph in" : "row-glyph out"}>
            {it.direction === "in" ? "↓" : "↑"}
          </span>
          <span className={it.direction === "in" ? "amt in" : "amt out"}>
            {it.direction === "in" ? "+" : ""}
            {it.token ? `${it.amount} ${it.token.symbol}` : `${formatHbar(it.amount)} ℏ`}
          </span>
          <span className="muted xsmall row-when">{new Date(it.timestamp).toLocaleString()}</span>
          <span className="link xsmall">›</span>
        </button>
      ))}
      {detail && <TxDetail item={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** Transaction detail — the receipt view, so Hashscan is a choice, not a need. */
function TxDetail({ item, onClose }: { item: HistoryItem; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h2>
          {item.direction === "in" ? "Received" : "Sent"}{" "}
          <span className={item.direction === "in" ? "amt in" : "amt out"}>
            {item.direction === "in" ? "+" : ""}
            {item.token ? `${item.amount} ${item.token.symbol}` : `${formatHbar(item.amount)} ℏ`}
          </span>
        </h2>
        <div className="confirm-row">
          <span className="muted small">{item.direction === "in" ? "From" : "To"}</span>
          <code className="addr">{item.counterparty ? shortAddr(item.counterparty) : "—"}</code>
        </div>
        {item.token && (
          <div className="confirm-row">
            <span className="muted small">Token</span>
            <code className="addr">{item.token.tokenId}</code>
          </div>
        )}
        {item.memo && (
          <div className="confirm-row">
            <span className="muted small">Memo</span>
            <span className="small">{item.memo}</span>
          </div>
        )}
        <div className="confirm-row">
          <span className="muted small">When</span>
          <span className="small">{new Date(item.timestamp).toLocaleString()}</span>
        </div>
        <div className="confirm-row">
          <span className="muted small">Tx</span>
          <code className="addr">{shortAddr(item.transactionId)}</code>
        </div>
        <a className="btn" href={item.hashscanUrl} target="_blank" rel="noreferrer">
          View on Hashscan ↗
        </a>
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * Native staking — stake the whole balance to a node with one transaction.
 * Nothing moves, nothing locks; rewards accrue daily.
 */
function StakeCard({
  wallet,
  accountReady,
}: {
  wallet: OculusVault;
  accountReady: boolean;
}) {
  const [info, setInfo] = useState<StakingInfo | null>(null);
  const [nodes, setNodes] = useState<NetworkNode[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [selNode, setSelNode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await wallet.getStakingInfo());
    } catch {
      /* transient mirror failure */
    }
  }, [wallet]);

  useEffect(() => {
    if (accountReady) void load();
  }, [accountReady, load]);

  const openChooser = async () => {
    setMsg(null);
    setChoosing(true);
    if (nodes.length === 0) {
      try {
        const n = await wallet.getNetworkNodes();
        setNodes(n);
        if (n.length > 0) setSelNode(String(n[0]!.nodeId));
      } catch {
        setMsg({ ok: false, text: "Couldn’t load the node list — try again." });
        setChoosing(false);
      }
    }
  };

  const stake = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.stakeToNode(Number(selNode));
      setMsg({ ok: true, text: `Staked to node ${selNode} · ${r.status}`, url: r.hashscanUrl });
      setChoosing(false);
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.stopStaking();
      setMsg({ ok: true, text: `Staking stopped · ${r.status}`, url: r.hashscanUrl });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Staking</h3>
      {!accountReady ? (
        <p className="muted xsmall">
          <span className="pending-stamp">Pending</span> Staking unlocks once
          your account exists — receive any HBAR first.
        </p>
      ) : info?.stakedNodeId != null ? (
        <>
          <div className="acct-row">
            <span>
              <strong>Node {info.stakedNodeId}</strong>{" "}
              <span className="muted xsmall">
                {nodes.find((n) => n.nodeId === info.stakedNodeId)?.description ?? ""}
              </span>
            </span>
            <span className="amt">
              +{formatHbar(info.pendingRewardHbar)} ℏ{" "}
              <span className="muted xsmall">pending</span>
            </span>
          </div>
          <p className="muted xsmall">
            Your balance is staked — nothing is locked, spending works
            normally. Rewards arrive with your next transaction.
          </p>
          <button className="btn ghost" disabled={busy} onClick={stop}>
            {busy ? "Working…" : "Stop staking"}
          </button>
        </>
      ) : !choosing ? (
        <>
          <p className="muted small">
            Stake your balance to a network node and earn rewards — nothing
            leaves your wallet, nothing locks up.
          </p>
          <button className="btn" disabled={busy} onClick={openChooser}>
            Stake my balance
          </button>
        </>
      ) : (
        <>
          <select
            className="input"
            value={selNode}
            aria-label="Node to stake to"
            onChange={(e) => setSelNode(e.target.value)}
          >
            {nodes.map((n) => (
              <option key={n.nodeId} value={String(n.nodeId)}>
                Node {n.nodeId} — {n.description}
              </option>
            ))}
          </select>
          <p className="muted xsmall">
            One small on-ledger fee (~$0.02 in ℏ). You can stop or switch nodes
            anytime.
          </p>
          <button className="btn primary" disabled={busy || !selNode} onClick={stake}>
            {busy ? "Staking…" : `Stake to node ${selNode}`}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setChoosing(false)}>
            Cancel
          </button>
        </>
      )}
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
  tokens,
  network,
  accountReady,
}: {
  wallet: OculusVault;
  onSent: () => void;
  balanceHbar: string | null;
  tokens: TokenBalance[];
  network: HederaNetwork;
  accountReady: boolean;
}) {
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  /** "hbar" or an HTS token id (0.0.x) held by this wallet. */
  const [asset, setAsset] = useState<string>("hbar");
  const [stage, setStage] = useState<"edit" | "confirm">("edit");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const token = asset === "hbar" ? null : tokens.find((t) => t.tokenId === asset) ?? null;
  const unit = token ? token.symbol : "ℏ";

  const validate = (): string | null => {
    const t = to.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(t) && !/^0\.0\.[0-9]+$/.test(t)) {
      return "Recipient must be a 0x address or 0.0.x account id.";
    }
    const a = Number(amount);
    if (!Number.isFinite(a) || a <= 0) return `Enter a positive ${unit} amount.`;
    if (token) {
      if (a > Number(token.balance)) {
        return `That’s more than your ${token.symbol} balance (${token.balance}).`;
      }
    } else if (balanceHbar != null && a > Number(balanceHbar)) {
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
      const r = token
        ? await wallet.sendToken(token.tokenId, to.trim(), amount.trim())
        : await wallet.send(to.trim(), amount.trim());
      pushRecent(network, to.trim());
      setMsg({
        ok: true,
        text: `Sent ${token ? amount : formatHbar(amount)} ${unit} · ${r.status}`,
        url: r.hashscanUrl,
      });
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
          <span className="confirm-amt">
            {token ? `${amount} ${token.symbol}` : `${formatHbar(amount)} ℏ`}
          </span>
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
      {tokens.length > 0 && (
        <select
          className="input"
          value={asset}
          aria-label="Asset to send"
          onChange={(e) => {
            setAsset(e.target.value);
            setMsg(null);
          }}
        >
          <option value="hbar">HBAR (ℏ)</option>
          {tokens.map((t) => (
            <option key={t.tokenId} value={t.tokenId}>
              {t.symbol} — {t.balance} available
            </option>
          ))}
        </select>
      )}
      <input className="input" placeholder="Recipient (0x… or 0.0.…)" value={to} onChange={(e) => setTo(e.target.value)} />
      {!to && loadRecents(network).length > 0 && (
        <div className="id-row">
          <span className="muted xsmall">Recent:</span>
          {loadRecents(network).map((addr) => (
            <button key={addr} className="chip" onClick={() => setTo(addr)}>
              {shortAddr(addr)}
            </button>
          ))}
        </div>
      )}
      <input
        className="input"
        placeholder={token ? `Amount (${token.symbol})` : "Amount (HBAR)"}
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      {token && (
        <p className="muted xsmall">
          The recipient must have {token.symbol} enabled in their wallet to
          receive it. Network fee is paid in ℏ.
        </p>
      )}
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
