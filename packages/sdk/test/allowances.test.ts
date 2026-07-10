import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKey } from "../src/crypto/keys.js";
import { approveAllowance } from "../src/hedera/allowances.js";
import { MirrorClient } from "../src/hedera/mirror.js";
import { getNetworkConfig } from "../src/hedera/networks.js";
import { MemoryStorage } from "../src/storage/Storage.js";
import { OculusVault } from "../src/wallet.js";

const OWNER = generateKey();

test("approveAllowance validates its argument shape before touching the network", async () => {
  const base = {
    network: "testnet" as const,
    ownerAccountId: "0.0.111",
    ownerPrivateKeyHex: OWNER.privateKeyHex,
    spenderAccountId: "0.0.222",
  };
  await assert.rejects(
    approveAllowance(base),
    /exactly one of amountHbar or token/,
  );
  await assert.rejects(
    approveAllowance({
      ...base,
      amountHbar: "1",
      token: { tokenId: "0.0.333", amountRaw: 1n },
    }),
    /exactly one of amountHbar or token/,
  );
  await assert.rejects(
    approveAllowance({ ...base, amountHbar: "-1" }),
    /can't be negative/,
  );
  await assert.rejects(
    approveAllowance({ ...base, token: { tokenId: "0.0.333", amountRaw: -1n } }),
    /can't be negative/,
  );
});

/** Mirror stub: owner 0.0.111 granted agent 0.0.222 an HBAR cap (1 ℏ, 0.6 ℏ
 * left) and a USDC-like 6-decimals token cap (25, untouched). */
function allowanceMirrorStub(url: RequestInfo | URL): Promise<Response> {
  const u = String(url);
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  if (u.includes("/allowances/crypto")) {
    assert.ok(u.includes("spender.id=0.0.222"), "must filter by spender");
    return json({
      allowances: [
        { owner: "0.0.111", spender: "0.0.222", amount: 60_000_000, amount_granted: 100_000_000 },
      ],
    });
  }
  if (u.includes("/allowances/tokens")) {
    return json({
      allowances: [
        { owner: "0.0.111", spender: "0.0.222", token_id: "0.0.429274", amount: 25_000_000, amount_granted: 25_000_000 },
      ],
    });
  }
  if (u.includes("/api/v1/tokens/0.0.429274")) {
    return json({ token_id: "0.0.429274", name: "USD Coin", symbol: "USDC", decimals: 6, type: "FUNGIBLE_COMMON" });
  }
  if (u.includes(`/api/v1/accounts/${OWNER.evmAddress}`)) {
    return json({ account: "0.0.111", evm_address: OWNER.evmAddress.toLowerCase(), balance: { balance: 0 } });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

test("MirrorClient.getAllowances merges HBAR + token rows with remaining/granted", async () => {
  const mirror = new MirrorClient(
    getNetworkConfig("testnet"),
    allowanceMirrorStub as typeof fetch,
  );
  const rows = await mirror.getAllowances("0.0.111", "0.0.222");
  assert.equal(rows.length, 2);
  const hbar = rows.find((r) => r.tokenId == null)!;
  assert.equal(hbar.remainingRaw, 60_000_000n);
  assert.equal(hbar.grantedRaw, 100_000_000n);
  const tok = rows.find((r) => r.tokenId === "0.0.429274")!;
  assert.equal(tok.remainingRaw, 25_000_000n);
});

test("wallet.getAgentAllowances is display-ready (symbols, exact decimals)", async () => {
  const wallet = new OculusVault({
    network: "testnet",
    keyProvider: {} as never,
    fetchImpl: allowanceMirrorStub as typeof fetch,
    agentStorage: new MemoryStorage(),
  });
  await wallet.unlockWithKey(OWNER.privateKeyHex, "42");
  const views = await wallet.getAgentAllowances("0.0.222");
  const hbar = views.find((v) => v.tokenId == null)!;
  assert.equal(hbar.symbol, "ℏ");
  assert.equal(hbar.remaining, "0.60000000");
  assert.equal(hbar.granted, "1.00000000");
  const usdc = views.find((v) => v.tokenId === "0.0.429274")!;
  assert.equal(usdc.symbol, "USDC");
  assert.equal(usdc.remaining, "25");
  assert.equal(usdc.granted, "25");
});
