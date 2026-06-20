#!/usr/bin/env bash
#
# deploy.sh — build OculusVault locally and ship it to the VPS.
#
# Frontend → /var/www/oculusvault (static, served by nginx)
# Backend  → /opt/oculusvault/server.cjs (single esbuild bundle, run by pm2)
#
# Usage:
#   ./scripts/deploy.sh
# Env:
#   DEPLOY_HOST   ssh target (default root@104.248.108.201)
#   SSHPASS       if set, password auth is used via `sshpass -e` (else use SSH keys)
#
set -euo pipefail

HOST="${DEPLOY_HOST:-root@104.248.108.201}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SSH="ssh -o StrictHostKeyChecking=accept-new"
SCP="scp -o StrictHostKeyChecking=accept-new"
RSH="ssh -o StrictHostKeyChecking=accept-new"
if [ -n "${SSHPASS:-}" ]; then
  SSH="sshpass -e $SSH"
  SCP="sshpass -e $SCP"
  RSH="sshpass -e ssh -o StrictHostKeyChecking=accept-new"
fi

echo "▶ Building SDK…"
npm run build

echo "▶ Building Mini App (uses apps/miniapp/.env.production)…"
npm run build --workspace @oculusvault/miniapp

echo "▶ Bundling backend…"
mkdir -p deploy
npx esbuild apps/server/src/index.ts \
  --bundle --platform=node --format=cjs --target=node20 \
  --outfile=deploy/server.cjs --log-level=warning

echo "▶ Shipping frontend → /var/www/oculusvault…"
if [ -n "${SSHPASS:-}" ]; then
  sshpass -e rsync -az --delete -e "ssh -o StrictHostKeyChecking=accept-new" \
    apps/miniapp/dist/ "$HOST:/var/www/oculusvault/"
else
  rsync -az --delete -e "ssh -o StrictHostKeyChecking=accept-new" \
    apps/miniapp/dist/ "$HOST:/var/www/oculusvault/"
fi

echo "▶ Shipping backend bundle → /opt/oculusvault…"
$RSH "$HOST" 'mkdir -p /opt/oculusvault'
$SCP deploy/server.cjs "$HOST:/opt/oculusvault/server.cjs"

echo "▶ Reloading backend (pm2)…"
$RSH "$HOST" 'cd /opt/oculusvault && (pm2 reload oculusvault-api || pm2 start server.cjs --name oculusvault-api --cwd /opt/oculusvault) && pm2 save'

echo "▶ Health check…"
$RSH "$HOST" 'curl -s localhost:8787/api/health'
echo
echo "✅ Deployed. https://oculusvault.com  ·  https://api.oculusvault.com/api/health"
