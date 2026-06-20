# oculusvault

A **non-custodial Hedera wallet inside a Telegram Mini App** — and a reusable
SDK to drop the same wallet into any app. One tap gives a Telegram user a real
Hedera account that can receive and send HBAR, with balance + history and a
Hashscan proof for every transaction. **Testnet-first.** Apache-2.0 licensed.

**Live (testnet beta):** [oculusvault.com](https://oculusvault.com) · API at `api.oculusvault.com`

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
packages/sdk     @oculusvault/sdk  — the reusable library (the core)
apps/server      thin backend: verifies initData, issues sessions, proxies Mirror Node
apps/miniapp     demo Telegram Mini App (React + Vite)
scripts/payin.mjs  simulates the "machine" paying a wallet (auto-create demo)
```

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

### Run it without Telegram (browser dev)

Set `ALLOW_DEV_AUTH=true` in `.env` (already on in the example). The Mini App
then authenticates against a guarded dev endpoint with a fake user, so you can
develop the whole flow in a normal browser. **Never enable this in production —
it bypasses initData verification.**

### Run it as a real Telegram Mini App

1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token into
   `TELEGRAM_BOT_TOKEN`.
2. Host the Mini App somewhere HTTPS (or tunnel, e.g. `cloudflared`/`ngrok`) and
   set that URL in BotFather: `/newapp` (or `/setmenubutton`).
3. Point `VITE_API_BASE` at your deployed backend and set `ALLOW_DEV_AUTH=false`.
4. Open the Mini App from the bot — you're authenticated via verified initData.

---

## The end-to-end demo (provision → receive → balance → Hashscan)

1. Open the Mini App → **create a wallet** (pick a password). You get an EVM
   address + QR. The Hedera account id is "not created yet" — that's expected.
2. Fund a testnet operator: grab an account + HBAR at
   [portal.hedera.com](https://portal.hedera.com/), put `OPERATOR_ID` /
   `OPERATOR_KEY` (ECDSA) in `.env`.
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
| `getBalance(idOrEvm?)` → `{ hbar, tinybar, usdEstimate }` | Balance via Mirror Node. |
| `getHistory(idOrEvm?)` → `HistoryItem[]` | Transfer history with Hashscan links. |
| `send(to, amountHbar, memo?)` → `{ txId, hashscanUrl, status }` | Send HBAR (to 0x or 0.0.x). |
| `onIncoming(cb, opts?)` → `unsubscribe` | Poll Mirror Node, fire on new credits. |
| `refreshAccountId()` | Re-check whether the account is auto-created yet. |
| `exportKey()` → `privateKeyHex` | Reveal the raw key (self-custody proof). |
| `lock()` | Wipe in-memory key material. |

Lower-level building blocks are also exported: `MirrorClient`, `sendHbar`,
`generateKey` / `fromPrivateKey`, `encryptPrivateKey` / `decryptPrivateKey`,
`registerPasskeySecret` / `getPasskeySecret`, `getNetworkConfig`,
`hashscanTxUrl`, and the `KeyProvider` interface.

### Swapping the key provider

`KeyProvider` is an interface. The shipped default,
`LocalEncryptedKeyProvider`, is vendor-free and self-custodial. To use an MPC
provider (e.g. Web3Auth) or a decentralized key network (Lit PKP), implement the
same interface and pass it to `OculusVault` — nothing else changes.

---

## Scope (v1)

- ✅ HBAR send/receive, balance, history, auto-create, export, incoming-watch.
- 🚫 **No mainnet by default** (testnet-first; the network is a config switch).
- 🚫 **No HTS tokens** in v1 — HBAR needs no association. HTS is a clean
  extension (associate, then transfer through the same `KeyProvider`).
- 🚫 No swaps, DeFi, or fiat on-ramp.

---

## Development

```bash
npm run build        # build the SDK
npm run typecheck    # typecheck all workspaces
npm test --workspace @oculusvault/sdk   # crypto + initData tests
```

## License

[Apache-2.0](./LICENSE) © Juan Manuel González. See also [NOTICE](./NOTICE).
