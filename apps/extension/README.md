# OculusVault Chrome extension

> **Live on the Chrome Web Store:**
> <https://chromewebstore.google.com/detail/oculusvault-%E2%80%94-hedera-wall/bnjmnccojfgihhloboehpmobigknnlfm>
> Install from there, or build and load it unpacked (see **Develop** below).

The same Telegram-anchored, non-custodial Hedera wallet — on desktop.
**Telegram stays the single source of truth**: the extension authenticates you
via the official Telegram Login Widget, the server verifies the signature and
issues the same session as the Mini App, and the extension opens the **same
encrypted vault record** (decrypted locally with the same password). Same
human → same wallet → same 0x address, everywhere.

```
Extension popup ── "Connect Telegram" ──▶ oculusvault.com/link.html
                                              │ official Telegram Login Widget
                                              ▼
                              POST /api/auth/telegram-login  (signature verified)
                                              │ same session JWT as the Mini App
                                              ▼
                          chrome.runtime.sendMessage → extension stores session
                                              │
                              GET /api/vault  (same ciphertext record)
                                              ▼
                     decrypt locally with your password → your wallet
```

Security properties:

- The server never sees keys or passwords — the extension is just another
  client of the ciphertext-only vault.
- The unlocked key is cached at most 15 minutes in `chrome.storage.session`
  (memory-only, cleared when the browser closes); otherwise you unlock with
  your password per session.
- `externally_connectable` is restricted to `https://oculusvault.com/*`; the
  background worker only accepts messages from that origin.
- Host permissions are limited to the OculusVault API and Hedera endpoints.

## Prerequisite (one-time, bot owner)

The Telegram Login Widget only works on a domain linked to the bot:
in [@BotFather](https://t.me/BotFather) run **`/setdomain`** → select the bot →
enter `oculusvault.com`.

## Develop

```bash
npm run build --workspace @oculusvault/extension   # → apps/extension/dist
```

Load it: `chrome://extensions` → enable **Developer mode** → **Load unpacked**
→ select `apps/extension/dist`. To iterate on the popup UI in a normal tab:
`npm run dev` in this folder and open `http://localhost:5175/popup.html`
(chrome.* APIs fall back to dev shims).

## Publish to the Chrome Web Store

The extension is **already published** — the
[live listing](https://chromewebstore.google.com/detail/oculusvault-%E2%80%94-hedera-wall/bnjmnccojfgihhloboehpmobigknnlfm)
was created with the steps below. They're kept as a reference for the first
listing of a fork; for shipping updates to the existing listing, jump to the
last line (bump `version`, rebuild, re-zip, upload).

1. **Developer account:** register at the
   [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole)
   (one-time $5 fee, Google account).
2. **Package:** `npm run zip --workspace @oculusvault/extension` →
   `apps/extension/oculusvault-extension.zip`.
3. **New item** → upload the zip.
4. **Store listing:** name, description, category (Productivity or Tools),
   the 128 px icon (already in the zip), and at least one 1280×800 screenshot
   of the popup (open the popup, zoom, capture).
5. **Privacy tab:** single purpose = "non-custodial Hedera wallet";
   justify permissions — `storage` (session + preferences),
   host permissions (own API + Hedera public nodes); declare that no user
   data is sold/transferred; remote code = none (everything is bundled).
6. **Submit for review.** First review typically takes a few days; wallet
   extensions sometimes get extra scrutiny — the open-source repo link helps.

Each update: bump `version` in `public/manifest.json`, rebuild, re-zip, upload.
