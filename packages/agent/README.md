# @oculusvault/agent

The **agent side** of [OculusVault](https://oculusvault.com)'s Agent Desk — the first consumer wallet with parental controls for AI agents.

A human hires your agent from their Telegram wallet and hands over show-once credentials: a **real Hedera account** whose key is a 1-of-2 KeyList `[owner, agent]`. The agent operates autonomously inside its budget; the owner stays a protocol-level co-owner who can **freeze, sweep, refill, or retire** the account at any moment — enforced by the network's key structure, never by policy.

Works anywhere you can run JavaScript: LangChain tools, ElizaOS plugins, Hedera Agent Kit, plain Node scripts.

## Install

```bash
npm install @oculusvault/agent
```

## Connect

Paste the credentials the Agent Desk showed once (JSON or the `.env` block):

```js
import { OculusAgent } from "@oculusvault/agent";

const agent = OculusAgent.connect({
  network: "testnet",
  accountId: process.env.HEDERA_ACCOUNT_ID,
  privateKey: process.env.HEDERA_PRIVATE_KEY,
  ownerAccountId: process.env.HEDERA_OWNER_ACCOUNT_ID, // for tiers 2–3
  auditTopicId: process.env.HEDERA_AUDIT_TOPIC_ID,     // optional logbook
});
```

## The three trust tiers

```js
// Tier 1 — petty cash: spend your own funded balance.
await agent.spend("0.0.4242", "1.5", "paying for the dataset");

// Tier 2 — allowance: spend from the OWNER's balance, up to the cap they
// granted (HIP-336). Revocable instantly, enforced by the network.
await agent.drawFromOwner("2");

// Tier 3 — ask-me: file a request the owner must co-sign in their wallet.
const req = await agent.requestApproval({
  amountHbar: "50",
  memo: "monthly compute bill",
  expiresInMinutes: 60,
});
const outcome = await agent.waitForApproval(req); // "executed" | "expired" | "timeout"
```

## The audit log

If the owner created an audit topic for you (Agent Desk → Audit), stamp what you do onto it — an append-only, consensus-timestamped public record:

```js
await agent.logActivity("bought 3 API credits for 1.5 ℏ");
```

Only your key can write to it; anyone can verify it on Hashscan.

## Design notes

- **Expect to be frozen.** `spend()` failing with `INVALID_SIGNATURE` means the owner rotated your key out. Stop working; the owner can re-issue credentials later.
- **A lost key is re-issued, not recovered.** Nothing is stored anywhere — ask your human to Freeze → Unfreeze in the Agent Desk to mint you a fresh key.
- **Exact amounts.** HBAR amounts are decimal strings; no floats touch the wire.
- Runnable end-to-end demo: [`examples/agent-demo.mjs`](../../examples/agent-demo.mjs) in the monorepo.

Apache-2.0 · part of the [OculusVault monorepo](https://github.com/jmgomezl/oculusvaultwallet)
