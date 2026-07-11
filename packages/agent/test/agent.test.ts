import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateKey } from "@hashgraph/sdk";
import { OculusAgent } from "../src/index.js";

const KEY = PrivateKey.generateECDSA().toStringRaw();

const creds = (over: Partial<Parameters<typeof OculusAgent.connect>[0]> = {}) =>
  OculusAgent.connect({
    network: "testnet",
    accountId: "0.0.555",
    privateKey: KEY,
    ownerAccountId: "0.0.111",
    ...over,
  });

test("connect validates the account id and exposes the identity", () => {
  const agent = creds();
  assert.equal(agent.accountId, "0.0.555");
  assert.equal(agent.ownerAccountId, "0.0.111");
  assert.throws(
    () => OculusAgent.connect({ network: "testnet", accountId: "0xabc", privateKey: KEY }),
    /0\.0\.x/,
  );
});

test("amount and prerequisite validation happens before any network call", async () => {
  const agent = creds();
  await assert.rejects(agent.spend("0.0.777", "0"), /positive/);
  await assert.rejects(agent.drawFromOwner("-1"), /positive/);
  await assert.rejects(agent.requestApproval({ amountHbar: 0 }), /positive/);
  await assert.rejects(
    agent.requestApproval({ amountHbar: 1, expiresInMinutes: 0 }),
    /≥ 1/,
  );
  const noOwner = OculusAgent.connect({
    network: "testnet",
    accountId: "0.0.555",
    privateKey: KEY,
  });
  await assert.rejects(noOwner.drawFromOwner("1"), /ownerAccountId/);
  await assert.rejects(noOwner.requestApproval({ amountHbar: 1 }), /ownerAccountId/);
  await assert.rejects(creds().logActivity("hi"), /No audit topic/);
  await assert.rejects(
    creds({ auditTopicId: "0.0.888" }).logActivity("x".repeat(2000)),
    /1024 bytes/,
  );
});

test("getBalance reads the mirror with exact tinybar math", async () => {
  const agent = creds({
    fetchImpl: ((url: RequestInfo | URL) => {
      assert.match(String(url), /\/api\/v1\/accounts\/0\.0\.555/);
      return Promise.resolve(
        new Response(JSON.stringify({ balance: { balance: 123_456_789 } }), { status: 200 }),
      );
    }) as typeof fetch,
  });
  assert.equal(await agent.getBalance(), "1.23456789");
});

test("waitForApproval resolves executed / expired / timeout from mirror state", async () => {
  let phase: "pending" | "executed" = "pending";
  const agent = creds({
    fetchImpl: ((url: RequestInfo | URL) => {
      assert.match(String(url), /\/api\/v1\/schedules\/0\.0\.9001/);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            executed_timestamp: phase === "executed" ? "123.456" : null,
            deleted: false,
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch,
  });

  const future = new Date(Date.now() + 60_000);
  // Executes on the second poll.
  const wait = agent.waitForApproval(
    { scheduleId: "0.0.9001", expiresAt: future },
    { pollMs: 10, timeoutMs: 5_000 },
  );
  setTimeout(() => {
    phase = "executed";
  }, 30);
  assert.equal(await wait, "executed");

  // Already past its expiry → expired without waiting for timeout.
  phase = "pending";
  assert.equal(
    await agent.waitForApproval(
      { scheduleId: "0.0.9001", expiresAt: new Date(Date.now() - 1000) },
      { pollMs: 10, timeoutMs: 5_000 },
    ),
    "expired",
  );

  // Deadline passes while still pending → timeout.
  assert.equal(
    await agent.waitForApproval(
      { scheduleId: "0.0.9001", expiresAt: future },
      { pollMs: 10, timeoutMs: 40 },
    ),
    "timeout",
  );
});
