# Deployment

OculusVault is deployed at **https://oculusvault.com** (Mini App) with its API at
**https://api.oculusvault.com**, on an Ubuntu VPS running nginx + pm2.

## Architecture on the server

```
nginx (:443, TLS via Let's Encrypt / certbot)
 ├─ oculusvault.com, www      → static files at /var/www/oculusvault   (the Mini App build)
 └─ api.oculusvault.com       → proxy_pass http://127.0.0.1:8787       (the backend)

pm2
 └─ oculusvault-api           → /opt/oculusvault/server.cjs (single bundled file)
                                reads /opt/oculusvault/.env
```

The backend is bundled into **one self-contained file** with esbuild, so the
server needs no `node_modules` and no build step on the box (it's RAM-constrained
and shared with other apps). The Mini App reads balances/history directly from the
public Hedera Mirror Node; the backend is only for Telegram `initData`
verification + sessions.

## Server `.env` (in `/opt/oculusvault/.env`, chmod 600)

```
HEDERA_NETWORK=testnet
PORT=8787
TELEGRAM_BOT_TOKEN=<real BotFather token>    # @oculusvaultbot — verifies initData
SESSION_SECRET=<32-byte random hex>
ALLOW_DEV_AUTH=false                         # never true in production
CORS_ORIGIN=https://oculusvault.com
VAULT_DATA_DIR=./data                        # encrypted records (ciphertext only)
# TELEGRAM_BOT_TOKENS={"kickoff":"…"}        # other apps that share the vault
```

Frontend build config lives in `apps/miniapp/.env.production` (on the build
machine, gitignored): `VITE_API_BASE=https://api.oculusvault.com`,
`VITE_HEDERA_NETWORK=testnet`, `VITE_BOT_USERNAME=oculusvaultbot` (makes the
landing's "Open in Telegram" CTAs live).

The shared vault persists encrypted records at `/opt/oculusvault/data/vault.json`
(ciphertext only — back it up like any small datastore). A browser visitor sees
only the landing page; the wallet itself exists exclusively inside the Telegram
Mini App, so the production posture is: dev-auth off, real bot token, CORS
locked to the site origin.

## Redeploy

From a machine with SSH access to the server:

```bash
# host defaults to root@104.248.108.201; override with DEPLOY_HOST
# password auth: export SSHPASS=... and the script uses sshpass -e if present
./scripts/deploy.sh
```

The script: builds the Mini App (with `apps/miniapp/.env.production`), bundles the
backend, rsyncs the frontend to `/var/www/oculusvault`, copies the backend bundle
to `/opt/oculusvault`, and `pm2 reload oculusvault-api`.

## TLS / DNS

DNS (`oculusvault.com` + `api.`, `www.`) already points at the server, and the
Let's Encrypt certificate (managed by certbot) covers all subdomains and
auto-renews. No cert action is needed for redeploys.
