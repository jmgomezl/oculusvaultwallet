import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorClient, getNetworkConfig } from "@oculusvault/sdk";
import { createNotifier } from "../src/notifier.js";

/** World with an empty wallet vault and ONE watched agent account 0.0.555
 * owned by uid 42. Mutate `agentTxs` / `schedules` between runOnce calls. */
function makeWorld() {
  const agentTxs: any[] = [];
  const schedules: any[] = [];
  const sent: Array<{ chatId: string; text: string }> = [];

  const mirrorFetch = ((url: RequestInfo | URL) => {
    const u = String(url);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (u.includes("/api/v1/schedules")) {
      assert.ok(u.includes("account.id=0.0.555"));
      return json({ schedules: [...schedules] });
    }
    if (u.includes("/api/v1/transactions") && u.includes("account.id=0.0.555")) {
      const gt = /timestamp=gt%3A([\d.]+)|timestamp=gt:([\d.]+)/.exec(u);
      const cursor = gt ? (gt[1] ?? gt[2]) : null;
      const order = u.includes("order=desc") ? "desc" : "asc";
      let list = [...agentTxs];
      if (cursor) list = list.filter((t) => t.consensus_timestamp > cursor!);
      list.sort((a, b) =>
        order === "desc"
          ? b.consensus_timestamp.localeCompare(a.consensus_timestamp)
          : a.consensus_timestamp.localeCompare(b.consensus_timestamp),
      );
      return json({ transactions: list });
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  const notifierFetch = ((url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("api.telegram.org") && u.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body));
      sent.push({ chatId: String(body.chat_id), text: String(body.text) });
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  const empty = { entries: () => [] as Array<[string, { record: string; updatedAt: string }]> };
  const agentWatch = {
    entries: (): Array<[string, { record: string; updatedAt: string }]> => [
      ["42", { record: JSON.stringify(["0.0.555"]), updatedAt: "" }],
    ],
  };

  const notifier = createNotifier({
    vault: empty as any,
    agentWatch: agentWatch as any,
    mirror: new MirrorClient(getNetworkConfig("testnet"), mirrorFetch),
    botToken: "TEST_TOKEN",
    cursorFile: join(mkdtempSync(join(tmpdir(), "ovagent-")), "cursors.json"),
    fetchImpl: notifierFetch,
    log: () => {},
  });

  return { agentTxs, schedules, sent, notifier };
}

const agentSpend = (ts: string, amt: number) => ({
  transaction_id: `0.0.555@${ts}`,
  consensus_timestamp: ts,
  charged_tx_fee: 100000,
  transfers: [
    { account: "0.0.555", amount: -amt - 100000 },
    { account: "0.0.777", amount: amt },
  ],
  token_transfers: [],
});

test("watched agent activity DMs the owner (spends, after silent seed)", async () => {
  const { agentTxs, sent, notifier } = makeWorld();

  // Seed pass: pre-existing agent history stays silent.
  agentTxs.push(agentSpend("1700000001.000000000", 100_000_000));
  await notifier.runOnce();
  assert.equal(sent.length, 0);

  // The agent spends 2 ℏ → owner gets one DM naming the agent account.
  agentTxs.push(agentSpend("1700000002.000000000", 200_000_000));
  await notifier.runOnce();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, "42");
  assert.match(sent[0]!.text, /0\.0\.555/);
  assert.match(sent[0]!.text, /spent/);
  assert.match(sent[0]!.text, /2\.001 ℏ/); // amount + fee, what really left
  assert.match(sent[0]!.text, /0\.0\.777/);

  // No double-notify.
  await notifier.runOnce();
  assert.equal(sent.length, 1);
});

test("a new pending schedule from a watched agent DMs an approval nudge once", async () => {
  const { schedules, sent, notifier } = makeWorld();
  await notifier.runOnce(); // seed

  schedules.push({
    schedule_id: "0.0.8001",
    creator_account_id: "0.0.555",
    payer_account_id: "0.0.555",
    consensus_timestamp: String(Date.now() / 1000 - 5),
    executed_timestamp: null,
    deleted: false,
    expiration_time: null,
    memo: "restock budget",
    transaction_body: "",
  });
  await notifier.runOnce();
  const nudges = sent.filter((s) => s.text.includes("approve"));
  assert.equal(nudges.length, 1);
  assert.match(nudges[0]!.text, /0\.0\.555/);
  assert.match(nudges[0]!.text, /restock budget/);
  assert.match(nudges[0]!.text, /Agent Desk/);

  // Same schedule never nudges twice.
  await notifier.runOnce();
  assert.equal(sent.filter((s) => s.text.includes("approve")).length, 1);
});
