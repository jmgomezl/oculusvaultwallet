#!/usr/bin/env node
/**
 * agent-demo.mjs — a complete OculusVault agent, end to end.
 *
 * You are the AGENT. A human hired you from their OculusVault wallet
 * (Agent Desk → Hire an agent) and pasted the show-once credentials into
 * your environment. This demo exercises every trust tier:
 *
 *   1. petty cash  — spend your own funded balance
 *   2. allowance   — draw from the OWNER's balance within their cap
 *                    (skipped gracefully if no allowance is granted)
 *   3. ask-me      — file an approval request and WAIT for the owner to
 *                    sign it in their wallet (or let it expire)
 *   …and stamp each action onto your public HCS audit log, if you have one.
 *
 * Env (the .env block the Agent Desk shows once):
 *   HEDERA_NETWORK=testnet
 *   HEDERA_ACCOUNT_ID=0.0.xxxx
 *   HEDERA_PRIVATE_KEY=<hex>
 *   HEDERA_OWNER_ACCOUNT_ID=0.0.yyyy
 *   HEDERA_AUDIT_TOPIC_ID=0.0.zzzz          (optional — Agent Desk → Audit)
 *   DEMO_PAY_TO=0.0.wwww                     (optional merchant, default: owner)
 *
 * Run from the repo root:  node examples/agent-demo.mjs
 */
import "dotenv/config";
import { OculusAgent } from "@oculusvault/agent";

const env = (k, fallback) => process.env[k] ?? fallback;
const die = (m) => {
  console.error(`\n❌ ${m}\n`);
  process.exit(1);
};

const network = env("HEDERA_NETWORK", "testnet");
const accountId = env("HEDERA_ACCOUNT_ID") ?? die("Set HEDERA_ACCOUNT_ID (from the Agent Desk handoff)");
const privateKey = env("HEDERA_PRIVATE_KEY") ?? die("Set HEDERA_PRIVATE_KEY (from the Agent Desk handoff)");
const ownerAccountId = env("HEDERA_OWNER_ACCOUNT_ID");
const auditTopicId = env("HEDERA_AUDIT_TOPIC_ID");
const payTo = env("DEMO_PAY_TO", ownerAccountId);

const agent = OculusAgent.connect({
  network,
  accountId,
  privateKey,
  ownerAccountId,
  auditTopicId,
});

const log = async (line) => {
  console.log(`   📓 ${line}`);
  if (agent.auditTopicId) {
    try {
      await agent.logActivity(line);
    } catch (e) {
      console.log(`   (audit log write failed: ${e.message})`);
    }
  }
};

console.log(`\n🤖 Agent ${agent.accountId} on ${network} (owner: ${ownerAccountId ?? "unknown"})`);
console.log(`💰 Petty cash: ${await agent.getBalance()} ℏ`);

// ── Tier 1: spend petty cash ────────────────────────────────────────────
console.log(`\n1) Spending 0.1 ℏ of petty cash → ${payTo}…`);
try {
  const r = await agent.spend(payTo, "0.1", "agent-demo: petty cash");
  console.log(`   ${r.status} (${r.transactionId})`);
  await log(`spent 0.1 ℏ petty cash → ${payTo}`);
} catch (e) {
  console.log(`   blocked: ${e.message} (frozen? empty? — the owner is in control)`);
}

// ── Tier 2: draw on the owner's allowance ───────────────────────────────
if (ownerAccountId) {
  console.log(`\n2) Drawing 0.1 ℏ from the owner's allowance…`);
  try {
    const r = await agent.drawFromOwner("0.1", undefined, "agent-demo: allowance draw");
    console.log(`   ${r.status} (${r.transactionId})`);
    await log(`drew 0.1 ℏ from owner allowance`);
  } catch (e) {
    console.log(`   no allowance available: ${e.message}`);
    console.log(`   (the owner grants one in Agent Desk → Allowance)`);
  }
} else {
  console.log(`\n2) Skipping allowance draw — no HEDERA_OWNER_ACCOUNT_ID set.`);
}

// ── Tier 3: ask the owner ───────────────────────────────────────────────
if (ownerAccountId) {
  console.log(`\n3) Requesting owner approval for 0.25 ℏ (expires in 10 min)…`);
  const req = await agent.requestApproval({
    amountHbar: "0.25",
    memo: "agent-demo: needs 0.25 for the bigger job",
    expiresInMinutes: 10,
  });
  console.log(`   filed schedule ${req.scheduleId} — check OculusVault → Agent Desk`);
  await log(`requested approval for 0.25 ℏ (schedule ${req.scheduleId})`);
  console.log(`   waiting up to 3 minutes for the owner…`);
  const outcome = await agent.waitForApproval(req, { timeoutMs: 3 * 60_000 });
  console.log(`   outcome: ${outcome.toUpperCase()}`);
  await log(`approval ${req.scheduleId}: ${outcome}`);
} else {
  console.log(`\n3) Skipping approval request — no HEDERA_OWNER_ACCOUNT_ID set.`);
}

console.log(`\n💰 Petty cash now: ${await agent.getBalance()} ℏ`);
console.log(`✅ Demo complete.${agent.auditTopicId ? ` Audit trail: topic ${agent.auditTopicId} (public, tamper-evident).` : ""}\n`);
