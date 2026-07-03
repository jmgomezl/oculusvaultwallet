# OculusVault

A **non-custodial Hedera wallet inside a Telegram Mini App** — and a reusable
SDK to drop the same wallet into any app. One tap gives a Telegram user a real
Hedera account that can receive and send HBAR, with balance + history, live USD
estimates, and a Hashscan proof for every transaction. Testnet by default, with
**mainnet behind an in-app switch and a plain-words safety gate** (same address
on both networks). Apache-2.0 licensed.

**Live (beta):** [oculusvault.com](https://oculusvault.com) · API at
`api.oculusvault.com` · bot [@oculusvaultbot](https://t.me/oculusvaultbot)

The interface follows **“The Engraved Note”** design language — the wallet as a
document of value: paper, engraved ink, guilloché, stamps, and ledgers, instead
of another dark crypto app.

> Built by a Hedera Developer Ambassador as an open-source ecosystem
> contribution. The driving use case: a recycling machine that pays people
> small amounts of HBAR — a stranger scans a QR and has a working wallet in
> seconds, with no seed phrase and no app install.

---

## Why it's actually non-custodial

The server **never** sees or stores a private key. Keys are generated **on the
device**, encrypted with a **user-only secret**, and only the **ciphertext** is
stored (Telegram CloudStorage). The Telegram identity *authorizes* access to a
wallet; it is **never** the seed. See [SECURITY.md](./SECURITY.md) for the full
threat model.

| Concern | How it's handled |
| --- | --- |
| Key generation | secp256k1 via audited [`@noble/curves`](https://github.com/paulmillr/noble-curves), client-side |
| Key at rest | XChaCha20-Poly1305 ciphertext; wrapping key = **Argon2id(user secret)** |
| User secret | WebAuthn **passkey PRF** when supported, else a **password** — never leaves the device |
| Identity | Telegram `initData` verified **server-side** (HMAC with the bot token) |
| Account model | ECDSA secp256k1 → one key is both an **EVM address** and a **Hedera account** |
| Account creation | Send HBAR to the EVM address → Hedera **auto-creates** the account |

---

## Repository layout

```
packages/sdk       @oculusvault/sdk — the reusable library (the core)
apps/server        thin backend: verifies initData, shared vault, Mirror proxy
apps/miniapp       the Mini App + the public landing page (React + Vite)
apps/extension     Chrome extension (MV3) — same vault, on desktop
scripts/payin.mjs  simulates the "machine" paying a wallet (auto-create demo)
scripts/e2e.mjs    headless on-chain smoke test of the whole loop
scripts/deploy.sh  build locally → ship to the server (see DEPLOY.md)
```

**Desktop too:** the [Chrome extension](./apps/extension/README.md)
authenticates with the official Telegram Login Widget and opens the **same
vault** as the Mini App — Telegram remains the single source of truth; the
extension is just another client of the ciphertext-only vault.

---

## Quick start (testnet)

```bash
git clone <this-repo> && cd oculusvault
npm install
npm run build              # build the SDK (apps depend on its dist/)

cp .env.example .env       # fill in TELEGRAM_BOT_TOKEN (and OPERATOR_* for payin)
cp apps/miniapp/.env.example apps/miniapp/.env
```

Run the backend and the Mini App in two terminals:

```bash
npm run dev:server         # http://localhost:8787
npm run dev:miniapp        # http://localhost:5173
```

### The wallet lives only in Telegram (by design)

One rule, no exceptions: **a browser sees the product landing page; the wallet
runs only inside the Telegram Mini App**, because the entire security model
hangs off the server-verified Telegram identity. There is no browser wallet and
no "demo wallet" — an unverified visitor can never create something that looks
like a real wallet.

For local development of the wallet UI in a browser, set
`VITE_FORCE_WALLET=true` in `apps/miniapp/.env.development` (gitignored,
dev-only; keys then live in that browser's localStorage). Similarly,
`ALLOW_DEV_AUTH=true` on the backend is for **local development only** — it
accepts unverified identities, so keep it `false` in production.

### Run it as a real Telegram Mini App

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. Host the app somewhere HTTPS (or tunnel, e.g. `cloudflared`/`ngrok`) and
   register the Mini App in BotFather: `/newapp` → your bot → that URL →
   **short name `app`** (this exact name makes `t.me/<bot>/app` pay links work).
3. Point `VITE_API_BASE` at your deployed backend, set
   `VITE_BOT_USERNAME=<yourbot>` (turns the landing's "Open in Telegram" CTAs
   live), and keep `ALLOW_DEV_AUTH=false`.
4. Open `t.me/<yourbot>/app` — you're authenticated via verified initData.

---

## The end-to-end demo (provision → receive → balance → Hashscan)

1. Open the Mini App → **create a wallet** (pick a password). You get an EVM
   address + QR. The Hedera account id is "not created yet" — that's expected.
2. Fund a testnet operator: grab an account + HBAR at
   [portal.hedera.com](https://portal.hedera.com/), put `OPERATOR_ID` /
   `OPERATOR_KEY` (ECDSA) in `.env`. (No operator? The official
   [Hedera faucet](https://faucet.hedera.com) sends free testnet ℏ — up to
   100 ℏ/day — straight to any 0x address, including the one the wallet
   shows you. The Receive tab links to it.)
3. Simulate the machine paying the new wallet:

   ```bash
   npm run payin -- 0xYourEvmAddressFromTheApp 5 "first deposit"
   ```

   The transfer **auto-creates** the Hedera account on receipt and prints a
   Hashscan link.
4. Back in the Mini App, the balance updates (Mirror Node poll), the account id
   appears, and the deposit shows in **History** with a working Hashscan link.
5. Tap **Export private key** to prove self-custody.

> **Automated check:** `npm run e2e` runs the whole loop headless against
> testnet (provision → auto-create → receive → balance → history → send) and
> prints Hashscan links. It accepts the Hedera portal's export names
> (`ACCOUNT_ID` / `HEX_ENCODED_PRIVATE_KEY`) directly.

---

## Use it as a dependency

```bash
npm install @oculusvault/sdk
```

### Client (Mini App / browser)

```ts
import {
  OculusVault,
  LocalEncryptedKeyProvider,
  TelegramCloudStorage,
  getInitData,
} from "@oculusvault/sdk";

// 1. Verify initData on YOUR backend and get back the trusted userId.
const { userId } = await fetch("/api/auth/verify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ initData: getInitData() }),
}).then((r) => r.json());

// 2. Build a wallet backed by Telegram CloudStorage.
const wallet = new OculusVault({
  network: "testnet",
  keyProvider: new LocalEncryptedKeyProvider(TelegramCloudStorage.fromWindow()),
});

// 3. Provision or recover — keys stay on-device, encrypted by the password.
const { evmAddress, hederaAccountId } = await wallet.createOrRecoverWallet({
  userId,
  secret: { source: "password", value: userPassword },
});

const balance = await wallet.getBalance();         // { hbar, tinybar, usdEstimate }
const history = await wallet.getHistory();          // [{ amount, hashscanUrl, ... }]
const { hashscanUrl } = await wallet.send("0.0.1234", "1.5");

const stop = wallet.onIncoming((t) => console.log("received", t.amount));
const privKey = await wallet.exportKey();           // self-custody
```

### Server (Node) — verify initData

```ts
import { verifyTelegramInitData } from "@oculusvault/sdk/server";

const verified = verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN!);
// verified.user.id is now trusted — use it to namespace the wallet.
```

---

## Public API

| Method | Description |
| --- | --- |
| `new OculusVault({ network, keyProvider, storageNamespace? })` | Construct a wallet. |
| `hasWallet(userId)` | Whether a wallet exists for this user (create-vs-unlock). |
| `createOrRecoverWallet({ userId, secret })` → `{ evmAddress, hederaAccountId }` | Provision or unlock. |
| `getBalance(idOrEvm?)` → `{ hbar, tinybar, usdEstimate }` | Balance via Mirror Node; USD from the network's own exchange-rate file (5-min cache). |
| `getHistory(idOrEvm?)` → `HistoryItem[]` | Transfer history with Hashscan links. |
| `send(to, amountHbar, memo?)` → `{ txId, hashscanUrl, status }` | Send HBAR (to 0x or 0.0.x). |
| `onIncoming(cb, opts?)` → `unsubscribe` | Poll Mirror Node, fire on new credits. |
| `switchNetwork(network)` | Instant testnet ⇄ mainnet switch — same key, same 0x address on every network; the per-network account id re-resolves lazily. |
| `refreshAccountId()` | Re-check whether the account is auto-created yet. |
| `exportKey()` → `privateKeyHex` | Reveal the raw key (self-custody proof). |
| `lock()` | Wipe in-memory key material. |

Lower-level building blocks are also exported: `MirrorClient`, `sendHbar`,
`generateKey` / `fromPrivateKey`, `encryptPrivateKey` / `decryptPrivateKey`,
`registerPasskeySecret` / `getPasskeySecret`, `getNetworkConfig`,
`hashscanTxUrl`, the `KeyProvider` / `Storage` interfaces,
`RemoteVaultStorage` (shared vault), the pay-intent protocol
(`parsePayIntent` / `buildPayParam` / `buildPayLink`), and Telegram helpers
(`getStartParam`, `scanQr`, `canScanQr`, `haptic`).

## One wallet across many apps (shared vault)

By default Telegram CloudStorage is per-bot, so each app would give a user a
*separate* wallet. To give a user **one wallet across all your apps** (e.g.
kickoff, hbadge, OculusVault) — while staying non-custodial — point the key
provider at the **shared vault**: a backend that stores **only the encrypted
record**, keyed by the user's Telegram id (which is the same across every bot).
Decryption always happens client-side; the server can't read a key.

**Server:** register each app's bot token so their users resolve to the same
vault:

```bash
TELEGRAM_BOT_TOKEN=<oculusvault bot token>
TELEGRAM_BOT_TOKENS={"kickoff":"<kickoff bot token>","hbadge":"<hbadge bot token>"}
```

**Client (e.g. kickoff's Mini App):** authenticate against the shared backend,
then back the wallet with `RemoteVaultStorage`:

```ts
import {
  OculusVault,
  LocalEncryptedKeyProvider,
  RemoteVaultStorage,
  getInitData,
} from "@oculusvault/sdk";

const VAULT_API = "https://api.oculusvault.com";

// verify initData (with this app's bot) → session token
const { token } = await fetch(`${VAULT_API}/api/auth/verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ initData: getInitData(), appId: "kickoff" }),
}).then((r) => r.json());

const wallet = new OculusVault({
  network: "testnet",
  keyProvider: new LocalEncryptedKeyProvider(
    new RemoteVaultStorage({ apiBase: VAULT_API, getToken: () => token }),
  ),
});

// Same human → same wallet, whether they came from kickoff or OculusVault.
await wallet.createOrRecoverWallet({ userId, secret: { source: "password", value: pw } });
```

The user uses the **same secret** (password/passkey) across apps to unlock the
shared wallet. Vault API: `GET/PUT/DELETE /api/vault` (Bearer session token);
records are validated to be encrypted and are size-capped.

> Just paying users? You don't need any of this — see "Use it as a dependency":
> kickoff's backend only needs the recipient address and `sendHbar`.

## Pay links (QR codes, NFC tags, deep links)

Anything that can show a URL — a machine's QR, an NFC tag, a chat message,
another app — can open the wallet **pre-filled** with a payment:

```
https://t.me/<YourBot>/app?startapp=pay_<address>_<amount>
```

The startapp param only allows `[A-Za-z0-9_-]`, so use `-` as the decimal
separator and in account ids: `pay_0xAbc…_1-5` (1.5 ℏ), `pay_0-0-1234_5`
(5 ℏ to 0.0.1234). The SDK exports the protocol:

```ts
import { buildPayLink, parsePayIntent } from "@oculusvault/sdk";

buildPayLink("OculusVaultBot", "0xAbc…", 1.5);
// → https://t.me/OculusVaultBot/app?startapp=pay_0xAbc…_1-5

parsePayIntent("pay_0-0-1234_5"); // → { to: "0.0.1234", amountHbar: "5" }
```

Inside the Mini App, `getStartParam()` + `parsePayIntent()` route the user
straight to a pre-filled, confirm-before-send screen; the Send tab also scans
QR codes with Telegram's native scanner (`scanQr()`). Intents carry only
public data (address + amount) — never secrets — and every send still requires
explicit user confirmation.

### Swapping the key provider

`KeyProvider` is an interface. The shipped default,
`LocalEncryptedKeyProvider`, is vendor-free and self-custodial. To use an MPC
provider (e.g. Web3Auth) or a decentralized key network (Lit PKP), implement the
same interface and pass it to `OculusVault` — nothing else changes.

---

## Scope (v1)

- ✅ HBAR send/receive, balance + USD, history, auto-create, export,
  incoming-watch, pay links / QR scan, shared cross-app vault.
- ✅ **Mainnet behind guardrails**: testnet by default; switching to mainnet
  requires a one-time, plain-words confirmation (real HBAR, unaudited beta,
  keep small amounts, back up first). Same address on both networks.
- 🚫 **No HTS tokens** in v1 — HBAR needs no association. HTS is a clean
  extension (associate, then transfer through the same `KeyProvider`).
- 🚫 No swaps, DeFi, or fiat on-ramp.

---

## Development

```bash
npm run build        # build the SDK
npm run typecheck    # typecheck all workspaces
npm test --workspace @oculusvault/sdk      # crypto, initData, pay-intent, network tests
npm test --workspace @oculusvault/server   # shared-vault integration tests
npm run e2e          # live on-chain smoke test (needs a funded testnet operator)
```

CI runs build + typecheck + both test suites on every push and PR. See
[DEPLOY.md](./DEPLOY.md) for the production setup.

## License

[Apache-2.0](./LICENSE) © Juan Manuel González. See also [NOTICE](./NOTICE).
