import "./landing.css";
import { Aperture } from "./Aperture.js";

const GITHUB = "https://github.com/jmgomezl/oculusvaultwallet";
/** Set VITE_BOT_USERNAME once the BotFather bot exists — the Telegram CTAs go
 * live automatically. Until then they show an honest "launching soon" state. */
const BOT = import.meta.env.VITE_BOT_USERNAME ?? "";
const TG_LINK = BOT ? `https://t.me/${BOT}/app` : null;

const MICRO =
  "NON·CUSTODIAL — KEYS NEVER LEAVE YOUR DEVICE — HEDERA — OCULUSVAULT — ".repeat(4);

/**
 * Public landing for oculusvault.com — set like an engraved certificate.
 * The hero is a specimen banknote that receives payment on a loop: the
 * product, shown as the thing it behaves like — money.
 */
export function Landing() {
  return (
    <div className="lp">
      <div className="lp-grain" aria-hidden />

      <nav className="lp-nav">
        <a className="lp-brand" href="#top">
          <Aperture size={30} />
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
          <span className="lp-stamp lp-stamp-green">Beta · Hedera testnet</span>
          <h1>
            Money that lives
            <br />
            in a <em>chat</em>.
          </h1>
          <p className="lp-lede">
            OculusVault hands anyone a real, self-custodial Hedera wallet inside
            Telegram — one tap, no seed phrase, no app install. Scan a QR, get
            paid in seconds.
          </p>
          <div className="lp-cta">
            <TelegramCta size="lg" />
            <a className="lp-btn lp-btn-ghost lp-btn-lg" href={GITHUB} target="_blank" rel="noreferrer">
              View the source
            </a>
          </div>
          <p className="lp-fine">Open-source · Apache-2.0 · keys never leave your device</p>
        </div>

        <div className="lp-hero-art" aria-hidden>
          <Banknote />
        </div>
      </header>

      <div className="lp-rule">
        <span className="lp-rule-micro">{MICRO}</span>
      </div>

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
        <h2 className="lp-h2">The one-tap payout</h2>
        <p className="lp-sub">
          Built for the real world — like a recycling machine that pays people a
          little HBAR per deposit. A stranger walks up and walks away with funds.
        </p>
        <div className="lp-steps">
          <Step n="I" title="Scan the QR" body="An external device shows a code that opens OculusVault in Telegram — authenticated by Telegram itself, verified on our server." />
          <Step n="II" title="A wallet appears" body="A secp256k1 keypair is generated on the device and encrypted with the user's secret. Its EVM address doubles as a Hedera account." />
          <Step n="III" title="HBAR lands" body="The first deposit auto-creates the Hedera account on-ledger. Balance updates live; every transfer links to a Hashscan proof." />
        </div>
      </section>

      <section className="lp-section" id="security">
        <h2 className="lp-h2">Actually non-custodial</h2>
        <p className="lp-sub">
          Most “non-custodial” Telegram wallets quietly hold your keys. This one
          can’t — and you can read the code to be sure.
        </p>
        <div className="lp-cards">
          <Card n="§1" title="Keys on your device" body="Generated client-side and held only in memory while unlocked. The server never sees them." />
          <Card n="§2" title="Encrypted at rest" body="Argon2id + XChaCha20-Poly1305 over your key. Only ciphertext is ever stored — never the key itself." />
          <Card n="§3" title="Telegram authorizes" body="initData is HMAC-verified server-side. Your Telegram identity unlocks access — it’s never the seed." />
          <Card n="§4" title="Export anytime" body="Take your private key whenever you want. Self-custody you can actually walk away with." />
        </div>
      </section>

      <section className="lp-section">
        <h2 className="lp-h2">Native to Hedera</h2>
        <div className="lp-feat">
          <Feat title="EVM-alias auto-create" body="Send HBAR to the wallet’s 0x address and Hedera creates the account on first receipt. No explicit account step." />
          <Feat title="One key, two networks" body="ECDSA secp256k1 means the same address works on testnet and mainnet — switch inside the app." />
          <Feat title="Mirror Node history" body="Balances and transfers read straight from Hedera’s public Mirror Node — verifiable, no middleman." />
          <Feat title="Hashscan on everything" body="Every transaction links to a public Hashscan record. Proof, not promises." />
        </div>
      </section>

      <section className="lp-beta">
        <div className="lp-beta-inner">
          <span className="lp-stamp lp-stamp-red lp-beta-stamp">Unaudited beta</span>
          <h3>Honest about the stage</h3>
          <p>
            OculusVault is an <strong>open-source beta on Hedera testnet</strong>,
            built as an ecosystem contribution by a Hedera Developer Ambassador.
            It has <strong>not had a third-party audit</strong> — don’t trust it
            with more than small amounts. Lost secret means lost wallet, by
            design. Testnet ℏ is free — claim yours at the{" "}
            <a href="https://faucet.hedera.com" target="_blank" rel="noreferrer">
              official Hedera faucet
            </a>{" "}
            and try everything risk-free.
          </p>
          <div className="lp-cta lp-cta-center">
            <TelegramCta size="lg" />
            <a className="lp-btn lp-btn-ghost lp-btn-lg" href={`${GITHUB}/blob/main/SECURITY.md`} target="_blank" rel="noreferrer">
              Read the security model
            </a>
          </div>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-foot-brand">
          <Aperture size={24} />
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
      Telegram — launching soon
    </span>
  );
}

/**
 * The hero: a specimen OculusVault note that gets PAID on a loop — a red
 * "RECEIVED +5 ℏ" stamp slams onto it, then lifts for the next visitor.
 */
function Banknote() {
  return (
    <div className="note" role="img" aria-label="An OculusVault note being paid 5 HBAR">
      <div className="note-inner">
        <div className="note-micro">{MICRO}</div>
        <div className="note-body">
          <div className="note-rosette">
            <Aperture size={168} hero />
          </div>
          <div className="note-face">
            <span className="note-issuer">OculusVault · Hedera Network</span>
            <span className="note-denom">
              5 <i>ℏ</i>
            </span>
            <span className="note-payline">pays the bearer on scan</span>
            <span className="note-serial">Nº OV-0000001 · testnet</span>
          </div>
          <span className="note-corner tl">5ℏ</span>
          <span className="note-corner br">5ℏ</span>
        </div>
        <div className="note-micro">{MICRO}</div>
      </div>
      <span className="note-specimen">Specimen</span>
      <div className="note-stamp">
        Received
        <b>+5 ℏ</b>
        <s>hashscan ↗ verified</s>
      </div>
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

function Card({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="lp-card">
      <span className="lp-card-n">{n}</span>
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
