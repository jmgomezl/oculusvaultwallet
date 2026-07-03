import "./landing.css";
import { Aperture } from "./Aperture.js";

const GITHUB = "https://github.com/jmgomezl/oculusvaultwallet";
/** Set VITE_BOT_USERNAME once the BotFather bot exists — the Telegram CTAs go
 * live automatically. Until then they show an honest "launching soon" state. */
const BOT = import.meta.env.VITE_BOT_USERNAME ?? "";
const TG_LINK = BOT ? `https://t.me/${BOT}/app` : null;

/**
 * Public landing for oculusvault.com. The browser shows the product; the
 * product itself lives in Telegram. No wallet runs here — the hero "wallet"
 * is a self-playing mock that acts out the one-tap payout story.
 */
export function Landing() {
  return (
    <div className="lp">
      <div className="lp-grain" aria-hidden />
      <div className="lp-glow lp-glow-a" aria-hidden />
      <div className="lp-glow lp-glow-b" aria-hidden />

      <nav className="lp-nav">
        <a className="lp-brand" href="#top">
          <Aperture size={26} />
          <span>OculusVault</span>
        </a>
        <div className="lp-nav-links">
          <a href="#how">How it works</a>
          <a href="#security">Security</a>
          <a href={GITHUB} target="_blank" rel="noreferrer">
            GitHub
          </a>
          <TelegramCta size="sm" />
        </div>
      </nav>

      <header className="lp-hero" id="top">
        <div className="lp-hero-copy">
          <span className="lp-badge">
            <i className="lp-dot" /> Beta · Hedera testnet
          </span>
          <h1>
            A Hedera wallet that<br />lives in a <em>chat</em>.
          </h1>
          <p className="lp-lede">
            OculusVault hands anyone a real, self-custodial Hedera account inside
            Telegram — one tap, no seed phrase, no app install. Scan a QR, get a
            wallet, get paid in seconds.
          </p>
          <div className="lp-cta">
            <TelegramCta size="lg" />
            <a className="lp-btn lp-btn-ghost lp-btn-lg" href={GITHUB} target="_blank" rel="noreferrer">
              View the source
            </a>
          </div>
          <p className="lp-fine">
            Open-source · Apache-2.0 · keys never leave your device
          </p>
        </div>

        <div className="lp-hero-art" aria-hidden>
          <div className="lp-orbit">
            <Aperture size={520} hero />
          </div>
          <WalletMock />
        </div>
      </header>

      <section className="lp-strip">
        {[
          ["~5s", "to a working wallet"],
          ["0", "private keys on our server"],
          ["1 tap", "no seed phrase"],
          ["100%", "open-source"],
        ].map(([big, small]) => (
          <div className="lp-stat" key={small}>
            <div className="lp-stat-big">{big}</div>
            <div className="lp-stat-small">{small}</div>
          </div>
        ))}
      </section>

      <section className="lp-section" id="how">
        <h2 className="lp-h2">
          The one-tap payout<span className="lp-h2-dot">.</span>
        </h2>
        <p className="lp-sub">
          Built for the real world — like a recycling machine that pays people a
          little HBAR per deposit. A stranger walks up and walks away with funds.
        </p>
        <div className="lp-steps">
          <Step n="01" title="Scan the QR" body="An external device shows a code that opens OculusVault in Telegram — authenticated by Telegram itself, verified on our server." />
          <Step n="02" title="A wallet appears" body="A secp256k1 keypair is generated on the device and encrypted with the user's secret. Its EVM address doubles as a Hedera account." />
          <Step n="03" title="HBAR lands" body="The first deposit auto-creates the Hedera account on-ledger. Balance updates live; every transfer links to a Hashscan proof." />
        </div>
      </section>

      <section className="lp-section lp-section-sec" id="security">
        <div className="lp-sec-head">
          <h2 className="lp-h2">
            Actually non-custodial<span className="lp-h2-dot">.</span>
          </h2>
          <p className="lp-sub">
            Most “non-custodial” Telegram wallets quietly hold your keys. This one
            can’t — and you can read the code to be sure.
          </p>
        </div>
        <div className="lp-cards">
          <Card icon="🔑" title="Keys on your device" body="Generated client-side and held only in memory while unlocked. The server never sees them." />
          <Card icon="🛡️" title="Encrypted at rest" body="Argon2id + XChaCha20-Poly1305 over your key. Only ciphertext is stored — never the key itself." />
          <Card icon="🪪" title="Telegram authorizes" body="initData is HMAC-verified server-side. Your Telegram identity unlocks access — it’s never the seed." />
          <Card icon="🚪" title="Export anytime" body="Take your private key whenever you want. Self-custody you can actually walk away with." />
        </div>
      </section>

      <section className="lp-section">
        <h2 className="lp-h2">
          Native to Hedera<span className="lp-h2-dot">.</span>
        </h2>
        <div className="lp-feat">
          <Feat title="EVM-alias auto-create" body="Send HBAR to the wallet’s 0x address and Hedera creates the account on first receipt. No explicit account step." />
          <Feat title="One key, two networks" body="ECDSA secp256k1 means the same address works on testnet and mainnet — switch inside the app." />
          <Feat title="Mirror Node history" body="Balances and transfers read straight from Hedera’s public Mirror Node — verifiable, no middleman." />
          <Feat title="Hashscan on everything" body="Every transaction links to a public Hashscan record. Proof, not promises." />
        </div>
      </section>

      <section className="lp-beta">
        <div className="lp-beta-inner">
          <h3>Honest about the stage</h3>
          <p>
            OculusVault is an <strong>open-source beta on Hedera testnet</strong>,
            built as an ecosystem contribution by a Hedera Developer Ambassador.
            It is <strong>not yet third-party audited</strong> — don’t trust it
            with more than small amounts. Lost secret means lost wallet, by design.
          </p>
          <div className="lp-cta">
            <TelegramCta size="lg" />
            <a className="lp-btn lp-btn-ghost lp-btn-lg" href={`${GITHUB}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">
              Read the security model
            </a>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-foot-brand">
          <Aperture size={22} />
          <span>OculusVault</span>
        </div>
        <p>
          Built on Hedera · Apache-2.0 · ©2026 Juan Manuel González ·{" "}
          <a href={GITHUB} target="_blank" rel="noreferrer">
            source
          </a>
        </p>
      </footer>
    </div>
  );
}

/** Primary CTA: live t.me link once the bot exists, honest "soon" otherwise. */
function TelegramCta({ size }: { size: "sm" | "lg" }) {
  const cls = size === "lg" ? "lp-btn lp-btn-lg" : "lp-btn lp-btn-sm";
  if (TG_LINK) {
    return (
      <a className={cls} href={TG_LINK} target="_blank" rel="noreferrer">
        Open in Telegram <span className="lp-arrow">→</span>
      </a>
    );
  }
  return (
    <span className={`${cls} lp-btn-soon`} title="The Telegram bot is almost ready">
      <i className="lp-dot" /> Telegram — launching soon
    </span>
  );
}

/**
 * The hero showpiece: a phone-sized wallet that plays the payout story on a
 * loop — QR waiting → payment toast → balance lands → Hashscan proof.
 * Pure CSS timeline, no state, decorative only.
 */
function WalletMock() {
  return (
    <div className="mock" role="img" aria-label="OculusVault wallet receiving 5 HBAR">
      <div className="mock-head">
        <span className="mock-brand">
          <Aperture size={15} /> OculusVault
        </span>
        <span className="mock-net">TESTNET</span>
      </div>

      <div className="mock-balance">
        <span className="mock-label">Balance</span>
        <span className="mock-amount">
          <span className="mock-zero">0 ℏ</span>
          <span className="mock-five">5 ℏ</span>
        </span>
        <span className="mock-usd">≈ $1.15 USD</span>
      </div>

      <div className="mock-qr">
        <MockQr />
        <span className="mock-qr-hint">Scan to pay this wallet</span>
      </div>

      <div className="mock-toast">🎉 Received 5 ℏ</div>

      <div className="mock-row">
        <span className="mock-in">＋5 ℏ</span>
        <span className="mock-row-sub">recycling machine · just now</span>
        <span className="mock-proof">Hashscan ↗</span>
      </div>
    </div>
  );
}

/** A QR-looking decorative grid (not a real code). */
function MockQr() {
  // Deterministic pseudo-random pattern so SSR/render is stable.
  const cells: boolean[] = [];
  let seed = 42;
  for (let i = 0; i < 121; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    cells.push(seed % 100 < 46);
  }
  // Finder squares
  const finder = (r: number, c: number) =>
    (r < 3 && c < 3) || (r < 3 && c > 7) || (r > 7 && c < 3);
  return (
    <div className="mock-qr-grid">
      {cells.map((on, i) => {
        const r = Math.floor(i / 11);
        const c = i % 11;
        return <i key={i} className={finder(r, c) || on ? "on" : ""} />;
      })}
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="lp-step">
      <span className="lp-step-n">{n}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function Card({ icon, title, body }: { icon: string; title: string; body: string }) {
  return (
    <div className="lp-card">
      <span className="lp-card-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function Feat({ title, body }: { title: string; body: string }) {
  return (
    <div className="lp-featitem">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}
