#!/usr/bin/env node
/**
 * payin.mjs — simulates the external "machine" paying a user.
 *
 * Sends testnet HBAR from a funded operator account to a target address. If
 * the target is a 0x EVM address with no account yet, Hedera AUTO-CREATES the
 * account on receipt — demonstrating the "provision a wallet by paying it" flow.
 *
 * Usage:
 *   OPERATOR_ID=0.0.xxxx OPERATOR_KEY=302e... \
 *   node scripts/payin.mjs <0xEvmAddressOr0.0.id> [amountHbar] [memo]
 *
 * Env (see .env.example):
 *   HEDERA_NETWORK   testnet | mainnet | previewnet   (default testnet)
 *   OPERATOR_ID      funded account id, e.g. 0.0.12345
 *   OPERATOR_KEY     operator ECDSA private key (hex or DER)
 */
import "dotenv/config";
import { sendHbar } from "@oculusvault/sdk";

const [, , target, amountArg, memoArg] = process.argv;
const amount = amountArg ?? "5";
const network = process.env.HEDERA_NETWORK ?? "testnet";
const operatorId = process.env.OPERATOR_ID;
const operatorKey = process.env.OPERATOR_KEY;

function die(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

if (!target) {
  die(
    "Missing target. Usage: node scripts/payin.mjs <0xEvm|0.0.id> [amountHbar] [memo]",
  );
}
if (!operatorId || !operatorKey || operatorKey === "PLACEHOLDER_OPERATOR_KEY") {
  die(
    "Set OPERATOR_ID and OPERATOR_KEY (a funded testnet account) in your env/.env.\n" +
      "   Get testnet funds at https://portal.hedera.com/",
  );
}

console.log(`\n🪙  Paying ${amount} HBAR → ${target} on ${network} ...`);
try {
  const result = await sendHbar({
    network,
    senderAccountId: operatorId,
    senderPrivateKeyHex: operatorKey,
    to: target,
    amountHbar: amount,
    memo: memoArg ?? "oculusvault payin",
  });
  console.log(`✅  Status:   ${result.status}`);
  console.log(`🧾  Tx:       ${result.transactionId}`);
  console.log(`🔎  Hashscan: ${result.hashscanUrl}`);
  if (String(target).startsWith("0x")) {
    console.log(
      `\nℹ️   If ${target} had no account, it was just AUTO-CREATED by this transfer.`,
    );
  }
  console.log();
} catch (err) {
  die(`Transfer failed: ${err?.message ?? err}`);
}
