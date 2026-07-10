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
  type TokenBalance,
  type TokenInfo,
  type WalletIdentity,
} from "@oculusvault/sdk";
import {
  buildPayLink,
  openTelegramLink,
  fromPrivateKey,
  SUGGESTED_TOKENS,
  isPasskeyPrfLikelySupported,
  createPasskeyQuickUnlock,
  unlockWithPasskeyQuickUnlock,
  type AgentView,
  type CreateAgentResult,
  type NetworkNode,
  type NftItem,
  type SendResult,
  type StakingInfo,
  type TopicMessage,
  type TopicRef,
} from "@oculusvault/sdk";
import { getNetworkConfig } from "@oculusvault/sdk";
import { authenticate, isDemoMode, type AuthResult } from "./api.js";
import { WcBridge, type WcProposal, type WcRequest, type WcSession } from "./wcBridge.js";
import { createWallet, DEFAULT_NETWORK } from "./walletFactory.js";
import { Qr } from "./Qr.js";
import { Landing } from "./Landing.js";
import { Aperture } from "./Aperture.js";

type Phase = "loading" | "error" | "locked" | "ready";
type View = "home" | "receive" | "send";

const NET_KEY = "oculusvault:network";
const MAINNET_ACK_KEY = "oculusvault:mainnetAck";
/** Bot username powering share/request links (t.me/<bot>/app?startapp=…). */
const BOT = import.meta.env.VITE_BOT_USERNAME ?? "";
/** WalletConnect project id (cloud.reown.com). Unset → dApp connections show
 * an honest coming-soon state; set it and rebuild to go live. */
const WC_PROJECT_ID = import.meta.env.VITE_WC_PROJECT_ID ?? "";

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

/** "2.5 ℏ to 0.0.7231440" — one human line for a pay intent. */
function payLine(p: PayIntent): string {
  const what = p.amountHbar
    ? p.tokenId
      ? `${p.amountHbar} of token ${p.tokenId}`
      : `${formatHbar(p.amountHbar)} ℏ`
    : p.tokenId
      ? `token ${p.tokenId}`
      : "a payment";
  return `${what} to ${shortAddr(p.to)}`;
}

/** Device-local passkey quick-unlock record (per user). The password-encrypted
 * vault record stays canonical; this only caches a passkey-wrapped copy. */
const pkqKey = (uid: string) => `oculusvault:pkq:${uid}`;

/** Recent send recipients, per network, most-recent-first, max 5. */
const recentsKey = (net: HederaNetwork) => `oculusvault:recents:${net}`;
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
  const [recovering, setRecovering] = useState(false);
  const [storedAddr, setStoredAddr] = useState<string | null>(null);
  const [pkRecord, setPkRecord] = useState<string | null>(null);
  const [pkOffer, setPkOffer] = useState(false);
  /** A pay deep-link is surfaced from the very first screen, so the "you
   * came here to pay someone" thread never drops across unlock/create.
   * Primary source: the SERVER-verified start param from auth (client-side
   * extraction proved unreliable on iOS); webview parsing is the fallback. */
  const [pendingPay, setPendingPay] = useState<PayIntent | null>(() =>
    parsePayIntent(getStartParam() ?? ""),
  );

  useEffect(() => {
    (async () => {
      try {
        const a = await authenticate();
        setAuth(a);
        if (a.startParam) {
          const verified = parsePayIntent(a.startParam);
          if (verified) setPendingPay(verified);
        }
        walletRef.current = createWallet(loadSavedNetwork());
        const exists = await walletRef.current.hasWallet(a.userId);
        setIsNew(!exists);
        try {
          setPkRecord(localStorage.getItem(pkqKey(a.userId)));
        } catch {
          /* storage unavailable */
        }
        setPhase("locked");
      } catch (e) {
        setError((e as Error).message);
        setPhase("error");
      }
    })();
  }, []);

  /** Offer Face ID after a secret-based unlock if the device can and no
   * quick-unlock record exists yet. */
  const maybeOfferPasskey = useCallback(async (uid: string) => {
    try {
      if (localStorage.getItem(pkqKey(uid))) return;
      if (await isPasskeyPrfLikelySupported()) setPkOffer(true);
    } catch {
      /* fine — password-only */
    }
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
      void maybeOfferPasskey(auth.userId);
    },
    [auth, maybeOfferPasskey],
  );

  /** Face ID / passkey unlock via the device-local record. Any failure falls
   * back to the password path with an explanation; a record that decrypts to
   * a DIFFERENT wallet than the vault holds is stale and gets dropped. */
  const onPasskeyUnlock = useCallback(async () => {
    const wallet = walletRef.current;
    if (!wallet || !auth || !pkRecord) return;
    const unwrapped = await unlockWithPasskeyQuickUnlock(pkRecord, {
      rpId: window.location.hostname,
    });
    if (!unwrapped) throw new Error("Passkey didn’t work here — use your password.");
    const vaultAddr = await wallet.storedAddress(auth.userId);
    if (vaultAddr && vaultAddr.toLowerCase() !== unwrapped.evmAddress.toLowerCase()) {
      try {
        localStorage.removeItem(pkqKey(auth.userId));
      } catch { /* fine */ }
      setPkRecord(null);
      throw new Error(
        "This device’s Face ID copy belongs to an older wallet — unlock with your password to refresh it.",
      );
    }
    const id = await wallet.unlockWithKey(unwrapped.privateKeyHex, auth.userId);
    haptic("success");
    setIdentity(id);
    setPhase("ready");
  }, [auth, pkRecord]);

  const onEnablePasskey = useCallback(async () => {
    const wallet = walletRef.current;
    if (!wallet || !auth || !identity) return;
    const rec = await createPasskeyQuickUnlock({
      privateKeyHex: await wallet.exportKey(),
      evmAddress: identity.evmAddress,
      passkey: {
        rpId: window.location.hostname,
        rpName: "OculusVault",
        userId: auth.userId,
        userName: auth.user.username ? `@${auth.user.username}` : "OculusVault",
      },
    });
    if (!rec) throw new Error("This device’s passkey doesn’t support it — password it is.");
    localStorage.setItem(pkqKey(auth.userId), rec);
    setPkRecord(rec);
    setPkOffer(false);
    haptic("success");
  }, [auth, identity]);

  const startRecover = useCallback(async () => {
    if (!walletRef.current || !auth) return;
    setStoredAddr(await walletRef.current.storedAddress(auth.userId));
    setRecovering(true);
  }, [auth]);

  const onRestore = useCallback(
    async (privateKeyHex: string, newPassword: string) => {
      if (!walletRef.current || !auth) return;
      const id = await walletRef.current.importWallet({
        userId: auth.userId,
        privateKeyHex,
        secret: { source: "password", value: newPassword },
      });
      // The key may have changed — any device-local passkey copy is stale.
      try {
        localStorage.removeItem(pkqKey(auth.userId));
      } catch { /* fine */ }
      setPkRecord(null);
      haptic("success");
      setIdentity(id);
      setRecovering(false);
      setPhase("ready");
      void maybeOfferPasskey(auth.userId);
    },
    [auth, maybeOfferPasskey],
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
        username={auth?.user.username}
        onUnlock={onUnlock}
        onRecover={startRecover}
        onPasskeyUnlock={!isNew && pkRecord ? onPasskeyUnlock : undefined}
        pendingPay={pendingPay}
      />
    );
  }

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
        passkeyOffer={pkOffer}
        onEnablePasskey={onEnablePasskey}
        onDismissPasskey={() => setPkOffer(false)}
        intent={pendingPay}
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
  onRecover,
  onPasskeyUnlock,
  pendingPay,
}: {
  isNew: boolean;
  username?: string;
  onUnlock: (pw: string) => Promise<void>;
  onRecover: () => void;
  onPasskeyUnlock?: () => Promise<void>;
  pendingPay?: PayIntent | null;
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

  const passkey = async () => {
    if (!onPasskeyUnlock) return;
    setErr("");
    setBusy(true);
    try {
      await onPasskeyUnlock();
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
      {pendingPay && (
        <div className="banner">
          <div>
            <strong>Payment request waiting.</strong>
            <span className="muted small">
              {" "}This link asks you to send <strong>{payLine(pendingPay)}</strong> —{" "}
              {isNew ? "create your vault" : "unlock"} to review it. Nothing is
              sent without your confirmation.
            </span>
          </div>
        </div>
      )}
      <div className="card">
        {onPasskeyUnlock && (
          <>
            <button className="btn primary" disabled={busy} onClick={passkey}>
              {busy ? "Working…" : "🔓 Unlock with Face ID / passkey"}
            </button>
            <p className="muted xsmall">or use your password:</p>
          </>
        )}
        <input
          className="input"
          type="password"
          placeholder="Password"
          value={pw}
          autoFocus={!onPasskeyUnlock}
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
      {isNew && (
        <p className="muted xsmall unlock-foot">
          🔒 Non-custodial · Argon2id + XChaCha20-Poly1305 · ciphertext only
        </p>
      )}
    </div>
  );
}

/**
 * Forgot-password recovery / key import. The pasted key's address is derived
 * live so the user can confirm it's the right wallet BEFORE anything is
 * written; replacing a different stored wallet requires an explicit opt-in.
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
      haptic("error");
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app unlock">
      <div className="unlock-mark">
        <Aperture size={72} hero />
      </div>
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

function Dashboard({
  wallet,
  identity,
  setIdentity,
  freshWallet,
  network,
  onSwitchNetwork,
  passkeyOffer,
  onEnablePasskey,
  onDismissPasskey,
  intent,
}: {
  wallet: OculusVault;
  identity: WalletIdentity;
  setIdentity: (id: WalletIdentity | null) => void;
  freshWallet: boolean;
  network: HederaNetwork;
  onSwitchNetwork: (n: HederaNetwork) => void;
  passkeyOffer: boolean;
  onEnablePasskey: () => Promise<void>;
  onDismissPasskey: () => void;
  /** A pay deep-link (NFC tag / QR / t.me link) jumps straight to Send.
   * Resolved by WalletApp (server-verified source preferred). */
  intent: PayIntent | null;
}) {
  const [view, setView] = useState<View>(intent ? "send" : "home");
  const [balance, setBalance] = useState<Balance | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [nfts, setNfts] = useState<NftItem[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [toast, setToast] = useState<string>("");
  const [exportOpen, setExportOpen] = useState(false);
  const [backupDone, setBackupDone] = useState(false);
  const [copied, setCopied] = useState<string>("");
  const [reqAmount, setReqAmount] = useState<string>("");
  const [reqAsset, setReqAsset] = useState<string>("hbar");
  const [requestMode, setRequestMode] = useState(false);

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
      haptic("success");
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

  // The backup banner's "Export now" must pull the Self-custody drawer open.
  const custodyRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (exportOpen && custodyRef.current) custodyRef.current.open = true;
  }, [exportOpen]);

  const usd = balance ? formatUsd(balance.usdEstimate) : null;

  if (view === "receive") {
    const reqToken = tokens.find((t) => t.tokenId === reqAsset) ?? null;
    const reqUnit = reqToken ? reqToken.symbol : "ℏ";
    const requestLink = BOT
      ? buildPayLink(
          BOT,
          identity.evmAddress,
          reqAmount && Number(reqAmount) > 0 ? reqAmount : undefined,
          reqToken ? reqToken.tokenId : undefined,
        )
      : null;
    const requesting = requestMode && requestLink != null;
    return (
      <div className={network === "mainnet" ? "app on-mainnet" : "app"}>
        <ViewHead title="Receive" onBack={() => setView("home")} />
        <div className="card center">
          <div className="qr-frame">
            <Qr value={requesting ? requestLink! : identity.evmAddress} />
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
              — anyone scanning this with their camera lands in OculusVault
              with your details pre-filled.{" "}
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
        </div>

        {requestLink && (
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
                  haptic("tap");
                  const label =
                    reqAmount && Number(reqAmount) > 0
                      ? `Pay me ${reqToken ? reqAmount : formatHbar(reqAmount)} ${reqUnit} with OculusVault`
                      : reqToken
                        ? `Pay me ${reqToken.symbol} with OculusVault`
                        : "Pay me with OculusVault";
                  openTelegramLink(
                    `https://t.me/share/url?url=${encodeURIComponent(requestLink)}&text=${encodeURIComponent(label)}`,
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
        )}

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
              on-ramp. <strong>We copy your address as you tap</strong>; paste
              it as the destination wallet there.
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
          tokens={tokens}
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

      {passkeyOffer && (
        <PasskeyOfferBanner onEnable={onEnablePasskey} onDismiss={onDismissPasskey} />
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

      <TokensCard
        wallet={wallet}
        tokens={tokens}
        network={network}
        accountReady={identity.hederaAccountId != null}
        onChanged={refresh}
      />

      <div className="svc-label">Services</div>
      <Drawer title="Agent Desk" sum="accounts for your AI agents">
        <AgentDeskCard
          wallet={wallet}
          network={network}
          accountReady={identity.hederaAccountId != null}
          onChanged={refresh}
        />
      </Drawer>
      {nfts.length > 0 && (
        <Drawer title="Collectibles" sum={`${nfts.length} item${nfts.length === 1 ? "" : "s"}`}>
          <NftCard nfts={nfts} wallet={wallet} onChanged={refresh} />
        </Drawer>
      )}
      <Drawer title="Staking" sum="earn on your balance">
        <StakeCard
          wallet={wallet}
          network={network}
          accountReady={identity.hederaAccountId != null}
        />
      </Drawer>
      <Drawer title="Mint a token" sum="issue your own">
        <MintCard
          wallet={wallet}
          accountReady={identity.hederaAccountId != null}
          onChanged={refresh}
        />
      </Drawer>
      <Drawer title="Smart contract" sum="call any contract">
        <ContractCard
          wallet={wallet}
          network={network}
          accountReady={identity.hederaAccountId != null}
        />
      </Drawer>
      <Drawer title="Notary" sum="stamp it on the ledger">
        <NotaryCard
          wallet={wallet}
          network={network}
          accountReady={identity.hederaAccountId != null}
        />
      </Drawer>
      <Drawer title="Connect to apps" sum="keep open while in use">
        <ConnectCard
          wallet={wallet}
          network={network}
          accountReady={identity.hederaAccountId != null}
        />
      </Drawer>
      <Drawer title="Self-custody" sum="export your key" innerRef={custodyRef}>
        <ExportRow
          open={exportOpen}
          setOpen={setExportOpen}
          reveal={(pw) => wallet.exportKeyWithSecret({ source: "password", value: pw })}
        />
      </Drawer>

      <HistoryList items={history} />
      <Footer />
    </div>
  );
}

/**
 * A closed drawer in the bureau: native <details> with a shared `name`, so
 * opening one closes the others — the desk never ends up with every drawer
 * pulled out at once. The card inside sheds its frame via CSS.
 */
function Drawer({
  title,
  sum,
  children,
  innerRef,
}: {
  title: string;
  sum?: string;
  children: React.ReactNode;
  innerRef?: React.Ref<HTMLDetailsElement>;
}) {
  return (
    <details className="drawer" ref={innerRef} {...({ name: "svc" } as object)}>
      <summary>
        <span className="d-title">{title}</span>
        {sum && <span className="d-sum muted xsmall">{sum}</span>}
      </summary>
      {children}
    </details>
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
  tokens,
  network,
  accountReady,
}: {
  wallet: OculusVault;
  onSent: () => void;
  prefill: PayIntent | null;
  balanceHbar: string | null;
  tokens: TokenBalance[];
  network: HederaNetwork;
  accountReady: boolean;
}) {
  const [to, setTo] = useState(prefill?.to ?? "");
  const [amount, setAmount] = useState(prefill?.amountHbar ?? "");
  /** "hbar" or an HTS token id (0.0.x) held by this wallet. */
  const [asset, setAsset] = useState<string>("hbar");
  /** The user explicitly picked an asset — stop auto-following the intent. */
  const [assetTouched, setAssetTouched] = useState(false);
  /** A scanned/linked intent asked for a token (kept even if we don't hold it,
   * so we can refuse to silently send HBAR instead). */
  const [wantedToken, setWantedToken] = useState<string | null>(
    prefill?.tokenId ?? null,
  );
  const [stage, setStage] = useState<"edit" | "confirm">("edit");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const token = asset === "hbar" ? null : tokens.find((t) => t.tokenId === asset) ?? null;
  const unit = token ? token.symbol : "ℏ";

  // A token intent pre-selects that token once balances load (unless the
  // user already chose an asset themselves).
  useEffect(() => {
    if (!wantedToken || assetTouched) return;
    if (tokens.some((t) => t.tokenId === wantedToken)) setAsset(wantedToken);
  }, [tokens, wantedToken, assetTouched]);

  const validate = (): string | null => {
    const t = to.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(t) && !/^0\.0\.[0-9]+$/.test(t)) {
      return "Recipient must be a 0x address or 0.0.x account id.";
    }
    // A token was requested but we don't hold it and the user hasn't
    // explicitly chosen another asset — never silently pay in HBAR instead.
    if (wantedToken && !assetTouched && token == null) {
      return `This request asks for token ${wantedToken}, which your wallet doesn’t hold. Enable/receive it first, or pick an asset yourself.`;
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
    setWantedToken(intent.tokenId ?? null);
    setAssetTouched(false);
    if (!intent.tokenId) setAsset("hbar");
  };

  const send = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = token
        ? await wallet.sendToken(token.tokenId, to.trim(), amount.trim())
        : await wallet.send(to.trim(), amount.trim());
      pushRecent(network, to.trim());
      haptic("success");
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
        {prefill && (
          <p className="small">
            🧾 <strong>Payment request:</strong> {payLine(prefill)}
          </p>
        )}
        <p className="muted small">
          <span className="pending-stamp">Pending</span>{" "}
          {prefill ? "To pay it, your" : "Your"} wallet first needs a deposit
          to activate its Hedera account. Share your address from{" "}
          <strong>Receive</strong>
          {network === "testnet" ? " or claim free testnet ℏ from the faucet" : ""}
          , then come back{prefill ? " — the request stays filled in, ready to confirm" : ""}.
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
      {tokens.length > 0 && (
        <select
          className="input"
          value={asset}
          aria-label="Asset to send"
          onChange={(e) => {
            setAsset(e.target.value);
            setAssetTouched(true);
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
      {wantedToken && !assetTouched && token == null && (
        <p className="error xsmall">
          This request asks for token {wantedToken}, which your wallet doesn’t
          hold — enable it in Tokens first, or pick an asset above.
        </p>
      )}
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

/**
 * HTS tokens the wallet holds, plus the opt-in flow. Receiving a token on
 * Hedera requires ASSOCIATING with it first (a small on-ledger fee in HBAR) —
 * this card makes that a one-tap action for USDC and a paste-the-id action
 * for anything else.
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

  // Major tokens (chain-verified registry) the wallet doesn't hold yet.
  const suggestions = SUGGESTED_TOKENS[network].filter(
    (k) => !tokens.some((t) => t.tokenId === k.tokenId),
  );
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
      haptic("success");
      setMsg({ ok: true, text: `${label} enabled · ${r.status}`, url: r.hashscanUrl });
      setPreview(null);
      setTokenIdIn("");
      setAdding(false);
      onChanged();
    } catch (e) {
      haptic("error");
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
          {suggestions.length > 0 && (
            <>
              <p className="muted xsmall">
                Well-known tokens — tap to enable (verified official ids,
                tiny ℏ fee each):
              </p>
              <div className="id-row" style={{ justifyContent: "flex-start" }}>
                {suggestions.map((k) => (
                  <button
                    key={k.tokenId}
                    className="chip"
                    title={`${k.name} · ${k.tokenId}`}
                    disabled={busy}
                    onClick={() => associate(k.tokenId, k.symbol)}
                  >
                    ＋ {k.symbol}
                  </button>
                ))}
              </div>
            </>
          )}
          {!adding && (
            <button className="btn ghost" disabled={busy} onClick={() => setAdding(true)}>
              Add by token ID
            </button>
          )}
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
      haptic("success");
      setMsg({
        ok: true,
        text: `Sent ${sending.name} #${sending.serialNumber} · ${r.status}`,
        url: r.hashscanUrl,
      });
      setSending(null);
      setTo("");
      onChanged();
    } catch (e) {
      haptic("error");
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

/**
 * Mint a token — the creation half of HTS. The wallet becomes treasury and
 * keeps admin + supply keys, so the creator retains full control. Amounts
 * are exact (the SDK rejects excess precision rather than truncating).
 */
function MintCard({
  wallet,
  accountReady,
  onChanged,
}: {
  wallet: OculusVault;
  accountReady: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [decimals, setDecimals] = useState("2");
  const [supply, setSupply] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const create = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.createFungibleToken({
        name,
        symbol,
        decimals: Number(decimals),
        initialSupply: supply.trim(),
      });
      haptic("success");
      setMsg({
        ok: true,
        text: `${symbol.toUpperCase()} is live — token ${r.tokenId} · ${r.status}`,
        url: r.hashscanUrl,
      });
      setOpen(false);
      setName(""); setSymbol(""); setSupply("");
      onChanged();
    } catch (e) {
      haptic("error");
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Mint a token</h3>
      {!accountReady ? (
        <p className="muted xsmall">
          <span className="pending-stamp">Pending</span> Minting unlocks once
          your account exists — receive any HBAR first.
        </p>
      ) : !open ? (
        <>
          <p className="muted small">
            Issue your own Hedera token in one step — this wallet becomes its
            treasury and keeps the keys. Costs about $1 in ℏ.
          </p>
          <button className="btn" disabled={busy} onClick={() => setOpen(true)}>
            Create a token
          </button>
        </>
      ) : (
        <>
          <input className="input" placeholder="Name (e.g. Engraved Points)" value={name}
                 onChange={(e) => setName(e.target.value)} />
          <div className="input-row">
            <input className="input" placeholder="Symbol (e.g. ENGR)" value={symbol}
                   onChange={(e) => setSymbol(e.target.value)} />
            <input className="input" placeholder="Decimals" inputMode="numeric" value={decimals}
                   style={{ maxWidth: 90 }} onChange={(e) => setDecimals(e.target.value)} />
          </div>
          <input className="input" placeholder="Initial supply (minted to you)" inputMode="decimal"
                 value={supply} onChange={(e) => setSupply(e.target.value)} />
          <button className="btn primary" disabled={busy || !name || !symbol || !supply} onClick={create}>
            {busy ? "Minting…" : "Mint it (~$1 in ℏ)"}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
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

/**
 * Smart contract — native SCS execution from the wallet. ABI-agnostic on
 * purpose: paste the calldata a dApp or ABI tool produced; the wallet signs
 * and executes. (dApps that speak WalletConnect get a nicer flow via the
 * Connect card — this is the raw door.)
 */
function ContractCard({
  wallet,
  network,
  accountReady,
}: {
  wallet: OculusVault;
  network: HederaNetwork;
  accountReady: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [value, setValue] = useState("");
  const [data, setData] = useState("");
  const [gas, setGas] = useState("120000");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const call = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.executeContract({
        contract: target,
        calldata: data.trim() || undefined,
        payableHbar: value.trim() || undefined,
        gas: Math.max(21_000, Number(gas) || 120_000),
      });
      haptic("success");
      setMsg({ ok: true, text: `Executed · ${r.status}`, url: r.hashscanUrl });
      onDoneReset();
    } catch (e) {
      haptic("error");
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const onDoneReset = () => { setTarget(""); setValue(""); setData(""); setOpen(false); };

  return (
    <div className="card">
      <h3>Smart contract</h3>
      {!accountReady ? (
        <p className="muted xsmall">
          <span className="pending-stamp">Pending</span> Contract calls unlock
          once your account exists — receive any HBAR first.
        </p>
      ) : !open ? (
        <>
          <p className="muted small">
            Call any Hedera contract directly — paste the target and calldata
            from the dApp or ABI tool you’re using.
          </p>
          <button className="btn" disabled={busy} onClick={() => setOpen(true)}>
            Call a contract
          </button>
        </>
      ) : (
        <>
          <input className="input" placeholder="Contract (0.0.… or 0x…)" value={target}
                 onChange={(e) => setTarget(e.target.value)} />
          <input className="input mono" placeholder="Calldata (0x…, optional)" value={data}
                 autoComplete="off" spellCheck={false} onChange={(e) => setData(e.target.value)} />
          <div className="input-row">
            <input className="input" placeholder="Value ℏ (optional)" inputMode="decimal" value={value}
                   onChange={(e) => setValue(e.target.value)} />
            <input className="input" placeholder="Gas" inputMode="numeric" value={gas}
                   style={{ maxWidth: 110 }} onChange={(e) => setGas(e.target.value)} />
          </div>
          <p className="muted xsmall">
            Only call contracts you trust with calldata you built yourself.
            {network === "mainnet" ? " Mainnet — real funds." : ""}
          </p>
          <button className="btn primary" disabled={busy || !target} onClick={call}>
            {busy ? "Executing…" : "Sign & execute"}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
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

/**
 * Notary — Hedera Consensus Service in plain words. A topic is your public
 * notebook; every entry gets an immutable consensus timestamp and sequence
 * number. Only this wallet can write to its notebooks (submit key); anyone
 * can verify them on Hashscan. This is the wallet's window onto HCS.
 */
function NotaryCard({
  wallet,
  network,
  accountReady,
}: {
  wallet: OculusVault;
  network: HederaNetwork;
  accountReady: boolean;
}) {
  const [topics, setTopics] = useState<TopicRef[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [messages, setMessages] = useState<TopicMessage[]>([]);
  const [creating, setCreating] = useState(false);
  const [memo, setMemo] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

  const hashscanBase = getNetworkConfig(network).hashscanBase;

  const loadTopics = useCallback(async () => {
    try {
      setTopics(await wallet.getTopics());
    } catch { /* transient mirror failure */ }
  }, [wallet]);

  const loadMessages = useCallback(async (topicId: string) => {
    try {
      setMessages(await wallet.getTopicMessages(topicId, 10));
    } catch { /* transient mirror failure */ }
  }, [wallet]);

  useEffect(() => {
    if (accountReady) void loadTopics();
  }, [accountReady, loadTopics]);

  useEffect(() => {
    if (sel) void loadMessages(sel);
    else setMessages([]);
  }, [sel, loadMessages]);

  const create = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.createTopic(memo.trim() || undefined);
      haptic("success");
      setMsg({ ok: true, text: `Notebook ${r.topicId} created · ${r.status}`, url: r.hashscanUrl });
      setCreating(false);
      setMemo("");
      // The receipt already knows the id — no need to wait for the mirror.
      setTopics((t) => [{ topicId: r.topicId, createdAt: new Date().toISOString() }, ...t]);
      setSel(r.topicId);
    } catch (e) {
      haptic("error");
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const stamp = async () => {
    if (!sel) return;
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.submitTopicMessage(sel, note.trim());
      haptic("success");
      setMsg({ ok: true, text: `Stamped · ${r.status}`, url: r.hashscanUrl });
      setNote("");
      // Mirror indexing lags consensus by a few seconds.
      setTimeout(() => void loadMessages(sel), 4000);
    } catch (e) {
      haptic("error");
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3>Notary</h3>
      {!accountReady ? (
        <p className="muted xsmall">
          <span className="pending-stamp">Pending</span> The notary unlocks
          once your account exists — receive any HBAR first.
        </p>
      ) : (
        <>
          <p className="muted small">
            Stamp words onto the public ledger. Every entry gets a consensus
            timestamp that can never be altered — proof of <em>what</em> you
            said and <em>when</em>. Notebooks and entries are public.
          </p>
          {topics.length > 0 && (
            <div className="id-row">
              {topics.map((t) => (
                <button
                  key={t.topicId}
                  className="chip"
                  style={sel === t.topicId ? { fontWeight: 700 } : undefined}
                  onClick={() => setSel(sel === t.topicId ? null : t.topicId)}
                >
                  {t.topicId}
                </button>
              ))}
            </div>
          )}
          {sel && (
            <>
              <div className="input-row">
                <input
                  className="input"
                  placeholder="Write an entry (max ~1000 characters)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && note.trim() && stamp()}
                />
                <button className="btn" disabled={busy || !note.trim()} onClick={stamp}>
                  {busy ? "…" : "Stamp"}
                </button>
              </div>
              {messages.map((m) => (
                <div className="acct-row" key={m.consensusTimestamp}>
                  <span className="small">
                    <span className="muted xsmall">#{m.sequenceNumber} · {new Date(m.timestamp).toLocaleString()}</span>
                    <br />
                    {m.message}
                  </span>
                </div>
              ))}
              <a
                className="link small"
                href={`${hashscanBase}/topic/${sel}`}
                target="_blank"
                rel="noreferrer"
              >
                Verify on Hashscan ↗
              </a>
            </>
          )}
          {!creating ? (
            <button className="btn ghost" disabled={busy} onClick={() => setCreating(true)}>
              New notebook (small ℏ fee)
            </button>
          ) : (
            <>
              <input
                className="input"
                placeholder="What is this notebook for? (public memo, optional)"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && create()}
              />
              <button className="btn primary" disabled={busy} onClick={create}>
                {busy ? "Creating…" : "Create notebook"}
              </button>
              <button className="btn ghost" disabled={busy} onClick={() => setCreating(false)}>
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

/**
 * Connect to apps (WalletConnect / HIP-820). The dApp does the dApp work;
 * OculusVault's job is the two consent moments: session approval (who is
 * connecting) and request approval (what exactly gets signed). Nothing signs
 * without a tap here.
 */
function ConnectCard({
  wallet,
  network,
  accountReady,
}: {
  wallet: OculusVault;
  network: HederaNetwork;
  accountReady: boolean;
}) {
  const [bridge, setBridge] = useState<WcBridge | null>(null);
  const [sessions, setSessions] = useState<WcSession[]>([]);
  const [proposal, setProposal] = useState<WcProposal | null>(null);
  const [request, setRequest] = useState<WcRequest | null>(null);
  const [uri, setUri] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!WC_PROJECT_ID || !accountReady) return;
    let dead = false;
    WcBridge.create({
      projectId: WC_PROJECT_ID,
      network,
      wallet,
      onProposal: (p) => {
        if (!dead) setProposal(p);
      },
      onRequest: (r) => {
        if (!dead) setRequest(r);
      },
      onSessionsChanged: (s) => {
        if (!dead) setSessions(s);
      },
    })
      .then((b) => {
        if (!dead) setBridge(b);
      })
      .catch((e) => {
        if (!dead) setMsg({ ok: false, text: (e as Error).message });
      });
    return () => {
      dead = true;
    };
    // network is fixed per Dashboard mount (key={network})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountReady]);

  const pair = async (raw: string) => {
    if (!bridge) return;
    setMsg(null);
    setBusy(true);
    try {
      await bridge.pair(raw);
      setUri("");
      setMsg({ ok: true, text: "Pairing… the app’s connection request appears here in a moment." });
    } catch (e) {
      haptic("error");
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const scan = async () => {
    const text = await scanQr("Scan the app’s WalletConnect QR");
    if (text) await pair(text);
  };

  const act = async (
    fn: () => Promise<void>,
    close: () => void,
    okText: string,
  ) => {
    setMsg(null);
    setBusy(true);
    try {
      await fn();
      haptic("success");
      setMsg({ ok: true, text: okText });
    } catch (e) {
      haptic("error");
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
      close();
    }
  };

  if (!WC_PROJECT_ID) {
    return (
      <div className="card">
        <h3>Connect to apps</h3>
        <p className="muted small">
          WalletConnect support for Hedera dApps (swap on SaucerSwap, use any
          dApp with this wallet as the signer) — <strong>coming soon</strong>.
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h3>Connect to apps</h3>
      {!accountReady ? (
        <p className="muted xsmall">
          <span className="pending-stamp">Pending</span> Connections unlock
          once your account exists — receive any HBAR first.
        </p>
      ) : (
        <>
          <p className="muted small">
            Use this wallet on any Hedera dApp: choose WalletConnect there,
            then paste its <code>wc:</code> link (or scan the QR). Keep this
            screen open while you use the app — every signature is approved
            here.
          </p>
          <div className="input-row">
            <input
              className="input"
              placeholder="wc:…"
              value={uri}
              onChange={(e) => setUri(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && uri && pair(uri)}
            />
            {!isDemoMode() && canScanQr() && (
              <button className="btn scan" disabled={busy || !bridge} onClick={scan} title="Scan the WalletConnect QR">
                ⌗
              </button>
            )}
          </div>
          <button
            className="btn"
            disabled={busy || !bridge || !uri}
            onClick={() => pair(uri)}
          >
            {bridge ? "Connect" : "Starting up…"}
          </button>
          {sessions.length > 0 && (
            <>
              <h3>Connected</h3>
              {sessions.map((s) => (
                <div className="acct-row" key={s.topic}>
                  <span>
                    <strong>{s.name}</strong>{" "}
                    <span className="muted xsmall">{s.url}</span>
                  </span>
                  <button
                    className="btn sm ghost"
                    disabled={busy}
                    onClick={() => bridge?.disconnect(s.topic)}
                  >
                    Disconnect
                  </button>
                </div>
              ))}
            </>
          )}
        </>
      )}
      {msg && <p className={msg.ok ? "success" : "error"}>{msg.text}</p>}

      {proposal && (
        <div className="modal-backdrop">
          <div className="card modal">
            <h2>Connect to {proposal.name}?</h2>
            <p className="muted small">
              {proposal.url && (
                <>
                  <code className="addr">{proposal.url}</code>
                  <br />
                </>
              )}
              This app will see your account Nº and can <strong>request</strong>{" "}
              transactions — each one still needs your approval here, every
              time.
            </p>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => act(proposal.approve, () => setProposal(null), `Connected to ${proposal.name}.`)}
            >
              Connect
            </button>
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => act(proposal.reject, () => setProposal(null), "Connection rejected.")}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {request && (
        <div className="modal-backdrop">
          <div className="card modal">
            <h2>{request.name} asks you to sign</h2>
            <p className="small">
              <strong>{request.summary}</strong>
            </p>
            <p className="muted xsmall">
              {request.method} · {network}
              {network === "mainnet" ? " — real funds" : ""}. Only approve if
              you just initiated this in {request.name} yourself.
            </p>
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => act(request.approve, () => setRequest(null), "Signed & sent to the app.")}
            >
              {busy ? "Signing…" : "Approve & sign"}
            </button>
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => act(request.reject, () => setRequest(null), "Request rejected.")}
            >
              Reject
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Agent Desk — accounts for AI agents, with the owner as protocol-level
 * co-owner. Every control here is enforced by the account's on-chain key
 * structure (a 1-of-2 KeyList), never by policy: Freeze rotates the agent's
 * key out, Sweep pulls funds home, Retire deletes the account. The agent's
 * private key is shown ONCE at creation and never stored — a lost key is
 * re-issued, not recovered.
 */
function AgentDeskCard({
  wallet,
  network,
  accountReady,
  onChanged,
}: {
  wallet: OculusVault;
  network: HederaNetwork;
  accountReady: boolean;
  onChanged: () => void;
}) {
  const [agents, setAgents] = useState<AgentView[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [initial, setInitial] = useState("5");
  const [busy, setBusy] = useState(false);
  /** Account id an action is running against (per-row spinners). */
  const [busyOn, setBusyOn] = useState<string>("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const [creds, setCreds] = useState<CreateAgentResult["credentials"] | null>(null);
  const [credName, setCredName] = useState("");
  const [copied, setCopied] = useState("");
  const [fundOpen, setFundOpen] = useState<string | null>(null);
  const [fundAmt, setFundAmt] = useState("");
  const [confirmRetire, setConfirmRetire] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAgents(await wallet.listAgents());
    } catch {
      /* transient mirror/vault failure — keep whatever we have */
    }
  }, [wallet]);

  // Keep the roster live: the mirror lags consensus by a few seconds, so a
  // just-created (or just-spent-from) agent account reads stale on the first
  // fetch. Poll while the drawer is mounted instead of trusting one read.
  useEffect(() => {
    if (!accountReady || !wallet.agentsEnabled) return;
    void load();
    const poll = setInterval(() => void load(), 8000);
    return () => clearInterval(poll);
  }, [accountReady, load, wallet]);

  const copy = (text: string, tag: string) => {
    navigator.clipboard.writeText(text).then(() => {
      haptic("tap");
      setCopied(tag);
      setTimeout(() => setCopied(""), 1500);
    });
  };

  /** Run a per-agent action, then reload after the mirror catches up. */
  const act = async (
    accountId: string,
    run: () => Promise<SendResult>,
    doneText: string,
  ) => {
    setMsg(null);
    setBusyOn(accountId);
    try {
      const r = await run();
      haptic("success");
      setMsg({ ok: true, text: `${doneText} · ${r.status}`, url: r.hashscanUrl });
      onChanged();
      void load();
      setTimeout(() => void load(), 5000); // key/balance changes lag on the mirror
    } catch (e) {
      haptic("error");
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusyOn("");
      setConfirmRetire(null);
      setFundOpen(null);
      setFundAmt("");
    }
  };

  const create = async () => {
    setMsg(null);
    setBusy(true);
    try {
      const r = await wallet.createAgent(name.trim(), initial.trim());
      haptic("success");
      setCreds(r.credentials);
      setCredName(r.agent.name);
      setCreating(false);
      setName("");
      setInitial("5");
      onChanged();
      void load();
    } catch (e) {
      haptic("error");
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (!accountReady) {
    return (
      <div className="card">
        <h3>Agent Desk</h3>
        <p className="muted xsmall">
          <span className="pending-stamp">Pending</span> The desk opens once
          your account exists — receive any HBAR first.
        </p>
      </div>
    );
  }

  // Show-once credential handoff — the only moment the agent key exists here.
  if (creds) {
    const credJson = JSON.stringify(
      {
        network: creds.network,
        accountId: creds.accountId,
        privateKey: creds.privateKeyHex,
        publicKey: creds.publicKeyHex,
      },
      null,
      2,
    );
    const envBlock = [
      `# ${credName} — OculusVault agent (${creds.network})`,
      `HEDERA_NETWORK=${creds.network}`,
      `HEDERA_ACCOUNT_ID=${creds.accountId}`,
      `HEDERA_PRIVATE_KEY=${creds.privateKeyHex}`,
    ].join("\n");
    return (
      <div className="card">
        <h3>“{credName}” is hired</h3>
        <p className="small">
          <strong>This is shown once.</strong>{" "}
          <span className="muted">
            Paste these credentials into your agent's runtime now — the key is
            not stored anywhere. If it's ever lost or leaked: Freeze, then
            Unfreeze re-issues a fresh key.
          </span>
        </p>
        <div className="acct-row">
          <code className="addr" onClick={() => copy(creds.accountId, "aid")}>
            {creds.accountId}
          </code>
          <button className="btn sm" onClick={() => copy(creds.accountId, "aid")}>
            {copied === "aid" ? "✓" : "Copy"}
          </button>
        </div>
        <div className="qr-frame">
          <Qr value={credJson} />
        </div>
        <div className="req-actions">
          <button className="btn primary" onClick={() => copy(envBlock, "env")}>
            {copied === "env" ? "Copied ✓" : "Copy .env block"}
          </button>
          <button className="btn" onClick={() => copy(credJson, "json")}>
            {copied === "json" ? "Copied ✓" : "Copy JSON"}
          </button>
        </div>
        <code className="addr req-preview" onClick={() => copy(envBlock, "env")}>
          {envBlock}
        </code>
        <button
          className="btn ghost"
          onClick={() => {
            setCreds(null);
            setCredName("");
            void load();
          }}
        >
          I've handed the credentials over — close
        </button>
      </div>
    );
  }

  const active = (agents ?? []).filter((a) => a.status !== "retired");
  const retired = (agents ?? []).filter((a) => a.status === "retired");

  return (
    <div className="card">
      <h3>Agent Desk</h3>
      <p className="muted small">
        Give an AI agent its own petty-cash account. You stay co-owner at the
        protocol level: freeze it, sweep the funds home, or retire it at any
        time — no cooperation from the agent needed.
      </p>

      {agents == null ? (
        <p className="muted xsmall">Opening the ledger…</p>
      ) : (
        active.map((a) => (
          <div className="agent-row" key={a.accountId}>
            <div className="agent-head">
              <strong>{a.name}</strong>
              <span className={a.status === "frozen" ? "agent-stamp frozen" : "agent-stamp"}>
                {a.status}
              </span>
              <span className="agent-bal">{formatHbar(a.balanceHbar)} ℏ</span>
            </div>
            <div className="id-row">
              <button className="chip" onClick={() => copy(a.accountId, a.accountId)}>
                {copied === a.accountId ? "copied ✓" : a.accountId}
              </button>
              <a className="chip" href={a.hashscanUrl} target="_blank" rel="noreferrer">
                activity ↗
              </a>
            </div>
            {fundOpen === a.accountId ? (
              <div className="input-row">
                <input
                  className="input"
                  placeholder="Amount (HBAR)"
                  inputMode="decimal"
                  value={fundAmt}
                  autoFocus
                  onChange={(e) => setFundAmt(e.target.value)}
                />
                <button
                  className="btn sm"
                  disabled={busyOn !== "" || !fundAmt || Number(fundAmt) <= 0}
                  onClick={() =>
                    act(a.accountId, () => wallet.fundAgent(a.accountId, fundAmt.trim()),
                      `Refilled ${a.name} with ${formatHbar(fundAmt)} ℏ`)
                  }
                >
                  {busyOn === a.accountId ? "…" : "Fund"}
                </button>
                <button className="btn ghost sm" onClick={() => setFundOpen(null)}>
                  ✕
                </button>
              </div>
            ) : confirmRetire === a.accountId ? (
              <div className="agent-actions">
                <span className="muted xsmall">
                  Retire {a.name}? Its account is deleted and the remaining{" "}
                  {formatHbar(a.balanceHbar)} ℏ returns to you. Final.
                </span>
                <button
                  className="btn sm danger"
                  disabled={busyOn !== ""}
                  onClick={() =>
                    act(a.accountId, () => wallet.retireAgent(a.accountId), `${a.name} retired`)
                  }
                >
                  {busyOn === a.accountId ? "…" : "Retire — I'm sure"}
                </button>
                <button className="btn ghost sm" onClick={() => setConfirmRetire(null)}>
                  Keep
                </button>
              </div>
            ) : (
              <div className="agent-actions">
                <button
                  className="btn sm"
                  disabled={busyOn !== ""}
                  onClick={() => { setFundOpen(a.accountId); setFundAmt(""); }}
                >
                  Fund
                </button>
                {a.status === "frozen" ? (
                  <button
                    className="btn sm"
                    disabled={busyOn !== ""}
                    onClick={() =>
                      act(a.accountId, () => wallet.unfreezeAgent(a.accountId),
                        `${a.name} unfrozen — its key works again`)
                    }
                  >
                    {busyOn === a.accountId ? "…" : "Unfreeze"}
                  </button>
                ) : (
                  <button
                    className="btn sm"
                    disabled={busyOn !== ""}
                    onClick={() =>
                      act(a.accountId, () => wallet.freezeAgent(a.accountId),
                        `${a.name} frozen — its key no longer signs`)
                    }
                  >
                    {busyOn === a.accountId ? "…" : "Freeze"}
                  </button>
                )}
                <button
                  className="btn sm"
                  disabled={busyOn !== "" || a.balanceTinybar <= 0n}
                  title="Pull the whole balance back to your wallet"
                  onClick={() =>
                    act(a.accountId, () => wallet.sweepAgent(a.accountId),
                      `Swept ${formatHbar(a.balanceHbar)} ℏ home from ${a.name}`)
                  }
                >
                  {busyOn === a.accountId ? "…" : "Sweep"}
                </button>
                <button
                  className="btn ghost sm"
                  disabled={busyOn !== ""}
                  onClick={() => setConfirmRetire(a.accountId)}
                >
                  Retire
                </button>
              </div>
            )}
          </div>
        ))
      )}
      {retired.length > 0 && (
        <p className="muted xsmall">
          {retired.length} retired agent{retired.length === 1 ? "" : "s"} in the
          ledger: {retired.map((a) => a.name).join(", ")}.
        </p>
      )}

      {!creating ? (
        <button className="btn" disabled={busy} onClick={() => { setMsg(null); setCreating(true); }}>
          Hire an agent
        </button>
      ) : (
        <>
          <input
            className="input"
            placeholder="Agent name (e.g. shopper)"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="input"
            placeholder="Petty cash (HBAR)"
            inputMode="decimal"
            value={initial}
            onChange={(e) => setInitial(e.target.value)}
          />
          <p className="muted xsmall">
            Creates a real Hedera account (~$0.05 fee) funded with{" "}
            {initial && Number(initial) > 0 ? `${formatHbar(initial)} ℏ` : "the amount above"}{" "}
            from this wallet — that's the agent's whole budget. Its private key
            appears ONCE on the next screen.
            {network === "mainnet" ? " Mainnet — real HBAR." : ""}
          </p>
          <button
            className="btn primary"
            disabled={busy || !name.trim() || !initial || Number(initial) <= 0}
            onClick={create}
          >
            {busy ? "Hiring…" : "Create agent account"}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => setCreating(false)}>
            Cancel
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

function HistoryList({ items }: { items: HistoryItem[] }) {
  const [detail, setDetail] = useState<HistoryItem | null>(null);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? items : items.slice(0, 4);
  return (
    <div className="card">
      <h3>History</h3>
      {items.length === 0 && <p className="muted small">No transactions yet.</p>}
      {shown.map((it) => (
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
          <span className="muted xsmall row-when">
            {new Date(it.timestamp).toLocaleString()}
          </span>
          <span className="link xsmall">›</span>
        </button>
      ))}
      {items.length > shown.length && (
        <button className="linklike" onClick={() => setShowAll(true)}>
          Show all ({items.length})
        </button>
      )}
      {showAll && items.length > 4 && (
        <button className="linklike" onClick={() => setShowAll(false)}>
          Show less
        </button>
      )}
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

/** One-time offer to add Face ID quick unlock on this device. */
function PasskeyOfferBanner({
  onEnable,
  onDismiss,
}: {
  onEnable: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const enable = async () => {
    setErr("");
    setBusy(true);
    try {
      await onEnable();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="banner">
      <div>
        <strong>Unlock with Face ID next time.</strong>
        <span className="muted small">
          {" "}Adds a passkey on this device only — your password keeps working
          everywhere, and stays the real backup.
        </span>
        {err && <p className="error xsmall">{err}</p>}
      </div>
      <div className="banner-actions">
        <button className="btn sm" disabled={busy} onClick={enable}>
          {busy ? "Setting up…" : "Enable"}
        </button>
        <button className="btn ghost sm" disabled={busy} onClick={onDismiss}>
          Not now
        </button>
      </div>
    </div>
  );
}

/**
 * Native staking — stake the whole balance to a node with one transaction.
 * Nothing moves, nothing locks; rewards accrue daily and arrive with the
 * account's next transaction.
 */
function StakeCard({
  wallet,
  network,
  accountReady,
}: {
  wallet: OculusVault;
  network: HederaNetwork;
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
      /* transient mirror failure — leave as-is */
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
      haptic("success");
      setMsg({ ok: true, text: `Staked to node ${selNode} · ${r.status}`, url: r.hashscanUrl });
      setChoosing(false);
      await load();
    } catch (e) {
      haptic("error");
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
      haptic("success");
      setMsg({ ok: true, text: `Staking stopped · ${r.status}`, url: r.hashscanUrl });
      await load();
    } catch (e) {
      haptic("error");
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
            Your balance is staked{network === "mainnet" ? " and earning" : ""} —
            nothing is locked, spending works normally. Rewards arrive with your
            next transaction.
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
      Non-custodial · keys stay on your device · open-source (Apache-2.0) ·
      build {__BUILD_ID__}
    </footer>
  );
}
