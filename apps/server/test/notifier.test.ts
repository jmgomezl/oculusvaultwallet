import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MirrorClient, getNetworkConfig } from "@oculusvault/sdk";
import { createNotifier } from "../src/notifier.js";

/** Scriptable mirror: mutate `txs` between runOnce() calls to simulate new
 * inbound transfers landing on-chain. */
function makeWorld() {
  const txs: any[] = [];
  const sent: Array<{ chatId: string; text: string }> = [];

  const mirrorFetch = ((url: RequestInfo | URL) => {
    const u = String(url);
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    if (u.includes("/api/v1/accounts/0xAA11")) {
      return json({ account: "0.0.111", balance: { balance: 0 } });
    }
    if (u.includes("/api/v1/tokens/0.0.429274")) {
      return json({
        token_id: "0.0.429274",
        name: "USD Coin",
        symbol: "USDC",
        decimals: "6",
        type: "FUNGIBLE_COMMON",
      });
    }
    if (u.includes("/api/v1/transactions")) {
      const gt = /timestamp=gt%3A([\d.]+)|timestamp=gt:([\d.]+)/.exec(u);
      const cursor = gt ? (gt[1] ?? gt[2]) : null;
      const order = u.includes("order=desc") ? "desc" : "asc";
      let list = [...txs];
      if (cursor) list = list.filter((t) => t.consensus_timestamp > cursor!);
      list.sort((a, b) =>
        order === "desc"
          ? b.consensus_timestamp.localeCompare(a.consensus_timestamp)
          : a.consensus_timestamp.localeCompare(b.consensus_timestamp),
      );
      const limit = Number(/limit=(\d+)/.exec(u)?.[1] ?? 25);
      return json({ transactions: list.slice(0, limit) });
    }
    if (u.includes("api.telegram.org")) {
      throw new Error("telegram must use the notifier fetch, not mirror fetch");
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

  const vault = {
    entries: (): Array<[string, { record: string; updatedAt: string }]> => [
      ["42", { record: JSON.stringify({ evmAddress: "0xAA11", ciphertext: "x", nonce: "y" }), updatedAt: "" }],
    ],
  };

  const notifier = createNotifier({
    vault: vault as any,
    mirror: new MirrorClient(getNetworkConfig("testnet"), mirrorFetch),
    botToken: "TEST_TOKEN",
    cursorFile: join(mkdtempSync(join(tmpdir(), "ovnotify-")), "cursors.json"),
    fetchImpl: notifierFetch,
    log: () => {},
  });

  return { txs, sent, notifier };
}

const hbarIn = (ts: string, amt: number) => ({
  transaction_id: `0.0.999@${ts}`,
  consensus_timestamp: ts,
  charged_tx_fee: 100000,
  transfers: [
    { account: "0.0.999", amount: -amt - 100000 },
    { account: "0.0.111", amount: amt },
  ],
  token_transfers: [],
});

test("notifier seeds silently, then DMs on new inbound transfers only", async () => {
  const { txs, sent, notifier } = makeWorld();

  // Pre-existing history must NOT notify (seed pass).
  txs.push(hbarIn("1700000001.000000000", 500_000_000));
  await notifier.runOnce();
  assert.equal(sent.length, 0);

  // Nothing new → still quiet.
  await notifier.runOnce();
  assert.equal(sent.length, 0);

  // A new 2 ℏ credit lands → exactly one DM to the right chat.
  txs.push(hbarIn("1700000002.000000000", 200_000_000));
  await notifier.runOnce();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.chatId, "42");
  assert.match(sent[0]!.text, /\+2 ℏ/);
  assert.match(sent[0]!.text, /hashscan/i);

  // Cursor advanced — the same tx never notifies twice.
  await notifier.runOnce();
  assert.equal(sent.length, 1);
});

test("notifier includes token symbol for inbound HTS transfers", async () => {
  const { txs, sent, notifier } = makeWorld();
  await notifier.runOnce(); // seed (empty history)

  txs.push({
    transaction_id: "0.0.999@1700000005.000000000",
    consensus_timestamp: "1700000005.000000000",
    charged_tx_fee: 100000,
    transfers: [{ account: "0.0.999", amount: -100000 }],
    token_transfers: [
      { token_id: "0.0.429274", account: "0.0.999", amount: -5_000_000 },
      { token_id: "0.0.429274", account: "0.0.111", amount: 5_000_000 },
    ],
  });
  await notifier.runOnce();
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.text, /\+5 USDC/);
});
