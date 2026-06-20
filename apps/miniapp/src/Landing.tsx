import "./landing.css";

const GITHUB = "https://github.com/jmgomezl/oculusvaultwallet";

/**
 * Public landing page for oculusvault.com — shown in a browser. Inside Telegram
 * the app skips straight to the wallet. The "Launch" actions call onLaunch,
 * which mounts the wallet flow.
 */
export function Landing({ onLaunch }: { onLaunch: () => void }) {
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
          <button className="lp-btn lp-btn-sm" onClick={onLaunch}>
            Launch
          </button>
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
            <button className="lp-btn lp-btn-lg" onClick={onLaunch}>
              Try the demo <span className="lp-arrow">→</span>
            </button>
            <a className="lp-btn lp-btn-ghost lp-btn-lg" href={GITHUB} target="_blank" rel="noreferrer">
              View the source
            </a>
          </div>
          <p className="lp-fine">
            Open-source · Apache-2.0 · keys never leave your device
          </p>
        </div>

        <div className="lp-hero-art" aria-hidden>
          <Aperture size={340} hero />
          <div className="lp-chip lp-chip-1">
            <span className="lp-chip-k">balance</span>
            <span className="lp-chip-v">5.00000000 ℏ</span>
          </div>
          <div className="lp-chip lp-chip-2">
            <span className="lp-chip-k">account</span>
            <span className="lp-chip-v mono">0.0.9287437</span>
          </div>
          <div className="lp-chip lp-chip-3">
            <span className="lp-chip-k">received</span>
            <span className="lp-chip-v">＋5 ℏ ✓</span>
          </div>
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
          <Card icon="🛡️" title="Encrypted at rest" body="Argon2id + XChaCha20-Poly1305 over your key. Only ciphertext is stored — in Telegram CloudStorage." />
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
          <Feat title="One key, two worlds" body="ECDSA secp256k1 means the same key is an EVM address and a Hedera account id." />
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
            with mainnet funds yet. Lost secret means lost wallet, by design.
          </p>
          <div className="lp-cta">
            <button className="lp-btn lp-btn-lg" onClick={onLaunch}>
              Open the testnet demo <span className="lp-arrow">→</span>
            </button>
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

/** Concentric aperture / vault-eye mark. */
function Aperture({ size, hero = false }: { size: number; hero?: boolean }) {
  return (
    <svg
      className={hero ? "lp-aperture lp-aperture-hero" : "lp-aperture"}
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
    >
      <defs>
        <linearGradient id="ap-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c5cff" />
          <stop offset="1" stopColor="#00e0c6" />
        </linearGradient>
        <radialGradient id="ap-core" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#00e0c6" stopOpacity="0.9" />
          <stop offset="0.6" stopColor="#7c5cff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#7c5cff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="100" cy="100" r="92" stroke="url(#ap-g)" strokeWidth="1.5" opacity="0.55" />
      <circle
        className="lp-ring-dash"
        cx="100"
        cy="100"
        r="74"
        stroke="url(#ap-g)"
        strokeWidth="2"
        strokeDasharray="6 10"
        opacity="0.8"
      />
      {hero &&
        Array.from({ length: 6 }).map((_, i) => (
          <line
            key={i}
            x1="100"
            y1="100"
            x2="100"
            y2="38"
            stroke="url(#ap-g)"
            strokeWidth="6"
            strokeLinecap="round"
            opacity="0.5"
            transform={`rotate(${i * 60} 100 100)`}
          />
        ))}
      <circle cx="100" cy="100" r="46" fill="url(#ap-core)" />
      <circle cx="100" cy="100" r="20" fill="#00e0c6" opacity="0.95" />
      <circle cx="100" cy="100" r="20" stroke="#0a0b0f" strokeWidth="3" />
    </svg>
  );
}
