#!/usr/bin/env node
/**
 * e2e.mjs — live end-to-end smoke test against a real Hedera network.
 *
 * Proves the full OculusVault happy path on-chain:
 *   provision a fresh wallet → operator pays in (account AUTO-CREATES) →
 *   balance → history + Hashscan → wallet sends some back (signs with its own
 *   auto-created key).
 *
 * ⚠️  Spends real funds (testnet by default; ~1 ℏ + a few cents of fees).
 *     The operator private key is read from env and never printed.
 *
 * Usage:
 *   node scripts/e2e.mjs
 *
 * Env (.env): HEDERA_NETWORK (default testnet) and a funded operator as either
 *   OPERATOR_ID + OPERATOR_KEY, or the Hedera portal names
 *   ACCOUNT_ID + HEX_ENCODED_PRIVATE_KEY.
 */
import "dotenv/config";
import {
  generateKey,
  sendHbar,
  MirrorClient,
  getNetworkConfig,
} from "@oculusvault/sdk";

const network = process.env.HEDERA_NETWORK ?? "testnet";
const operatorId = process.env.OPERATOR_ID ?? process.env.ACCOUNT_ID;
const operatorKey =
  process.env.OPERATOR_KEY ?? process.env.HEX_ENCODED_PRIVATE_KEY;

if (!operatorId || !operatorKey) {
  console.error(
    "Missing operator: set OPERATOR_ID + OPERATOR_KEY (or ACCOUNT_ID + HEX_ENCODED_PRIVATE_KEY) in .env",
  );
  process.exit(1);
}

const cfg = getNetworkConfig(network);
const mirror = new MirrorClient(cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(label, fn, { tries = 20, intervalMs = 3000 } = {}) {
  for (let i = 1; i <= tries; i++) {
    const v = await fn();
    if (v) return v;
    process.stdout.write(`   …${label} (try ${i}/${tries})\r`);
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

console.log(`\n🌐 Network: ${network}`);
console.log(`🏦 Operator: ${operatorId}`);
const opBal = await mirror.getBalance(operatorId);
console.log(`   Operator balance: ${opBal.hbar} ℏ\n`);

// 1) Fresh non-custodial wallet (the keypair the Mini App generates on-device).
const wallet = generateKey();
console.log(`👛 New wallet EVM address: ${wallet.evmAddress}`);
console.log(`   (account id: not created yet — should auto-create on deposit)\n`);

// 2) The "machine" pays in → auto-creates the account.
console.log(`🪙  Paying in 5 ℏ from operator → new wallet …`);
const payin = await sendHbar({
  network,
  senderAccountId: operatorId,
  senderPrivateKeyHex: operatorKey,
  to: wallet.evmAddress,
  amountHbar: "5",
  memo: "oculusvault e2e payin",
});
console.log(`   status: ${payin.status}`);
console.log(`   hashscan: ${payin.hashscanUrl}\n`);

// 3) Wait for auto-create + balance.
const resolved = await pollUntil("account auto-create", async () => {
  const acct = await mirror.resolveAccount(wallet.evmAddress);
  return acct && acct.balanceTinybar > 0n ? acct : null;
});
console.log(`\n✅ Account auto-created: ${resolved.accountId}`);
const bal1 = await mirror.getBalance(resolved.accountId);
console.log(`   Wallet balance: ${bal1.hbar} ℏ\n`);

// 4) History + Hashscan proof.
const hist1 = await mirror.getHistory(resolved.accountId, { limit: 5 });
console.log(`📜 History (${hist1.length} item(s)):`);
for (const h of hist1) {
  console.log(`   ${h.direction === "in" ? "＋" : "－"}${h.amount} ℏ  ${h.hashscanUrl}`);
}

// 5) Send FROM the new wallet — exercises signing with its own key.
console.log(`\n📤 Sending 1 ℏ from new wallet → operator …`);
const sendBack = await sendHbar({
  network,
  senderAccountId: resolved.accountId,
  senderPrivateKeyHex: wallet.privateKeyHex,
  to: operatorId,
  amountHbar: "1",
  memo: "oculusvault e2e sendback",
});
console.log(`   status: ${sendBack.status}`);
console.log(`   hashscan: ${sendBack.hashscanUrl}`);

// 6) Confirm the outbound shows up.
const sawOut = await pollUntil("outbound tx in history", async () => {
  const h = await mirror.getHistory(resolved.accountId, { limit: 10 });
  return h.find((x) => x.direction === "out") ?? null;
});
const bal2 = await mirror.getBalance(resolved.accountId);
console.log(`\n✅ Outbound confirmed: ${sawOut.amount} ℏ  ${sawOut.hashscanUrl}`);
console.log(`   Final wallet balance: ${bal2.hbar} ℏ (5 − 1 − fees)\n`);
console.log(`🎉 End-to-end PASS: provision → auto-create → receive → balance → history → send\n`);
