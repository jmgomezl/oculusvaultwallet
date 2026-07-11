import { test } from "node:test";
import assert from "node:assert/strict";
import * as HashgraphProto from "@hashgraph/proto";
import { describeScheduledBody } from "../src/hedera/schedules.js";
import { MirrorClient } from "../src/hedera/mirror.js";
import { getNetworkConfig } from "../src/hedera/networks.js";
import { MemoryStorage } from "../src/storage/Storage.js";
import { OculusVault } from "../src/wallet.js";
import { encryptAgentRegistry, type AgentRecord } from "../src/agentRegistry.js";
import { generateKey } from "../src/crypto/keys.js";

const { proto } = HashgraphProto;

/** Real bytes from the live Phase-0 run: 0.1 ℏ from 0.0.7231440 → 0.0.9515337. */
const LIVE_TRANSFER_BODY = "CIDC1y9KHgocCgwKBRjQr7kDEP/ZxAkKDAoFGMnixAQQgNrECQ==";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
/** protobufjs accepts plain numbers at runtime; its typings insist on Long. */
const asBody = (o: unknown) => o as HashgraphProto.proto.ISchedulableTransactionBody;

test("describeScheduledBody decodes a real HBAR transfer from live bytes", () => {
  const desc = describeScheduledBody(LIVE_TRANSFER_BODY);
  assert.equal(desc.kind, "transfer");
  const out = desc.movements.find((m) => m.amountRaw < 0n)!;
  assert.equal(out.accountId, "0.0.7231440");
  assert.equal(out.amountRaw, -10_000_000n);
  const inn = desc.movements.find((m) => m.amountRaw > 0n)!;
  assert.equal(inn.accountId, "0.0.9515337");
  assert.equal(inn.amountRaw, 10_000_000n);
});

test("describeScheduledBody decodes token transfers and memos", () => {
  const bytes = proto.SchedulableTransactionBody.encode(asBody({
    memo: "buy the dataset",
    cryptoTransfer: {
      tokenTransfers: [
        {
          token: { shardNum: 0, realmNum: 0, tokenNum: 429274 },
          transfers: [
            { accountID: { accountNum: 111 }, amount: -5_000_000 },
            { accountID: { accountNum: 222 }, amount: 5_000_000 },
          ],
        },
      ],
    },
  })).finish();
  const desc = describeScheduledBody(b64(bytes));
  assert.equal(desc.kind, "transfer");
  assert.equal(desc.memo, "buy the dataset");
  const out = desc.movements.find((m) => m.amountRaw < 0n)!;
  assert.equal(out.tokenId, "0.0.429274");
  assert.equal(out.accountId, "0.0.111");
});

test("describeScheduledBody flags non-transfer operations honestly", () => {
  const bytes = proto.SchedulableTransactionBody.encode(asBody({
    tokenMint: { token: { tokenNum: 999 }, amount: 1 },
  })).finish();
  const desc = describeScheduledBody(b64(bytes));
  assert.equal(desc.kind, "other");
  assert.equal(desc.operation, "tokenMint");
});

const OWNER = generateKey();
/** Owner account 0.0.111; agent "shopper" 0.0.9001 with one pending schedule
 * asking 0.5 ℏ from the owner, one already-executed row, one expired row. */
function scheduleMirrorStub(url: RequestInfo | URL): Promise<Response> {
  const u = String(url);
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  if (u.includes("/api/v1/schedules")) {
    assert.ok(u.includes("account.id=0.0.9001"));
    const nowSec = Date.now() / 1000;
    const pendingBody = proto.SchedulableTransactionBody.encode(asBody({
      memo: "restock budget",
      cryptoTransfer: {
        transfers: {
          accountAmounts: [
            { accountID: { accountNum: 111 }, amount: -50_000_000 },
            { accountID: { accountNum: 9001 }, amount: 50_000_000 },
          ],
        },
      },
    })).finish();
    return json({
      schedules: [
        {
          schedule_id: "0.0.7001",
          creator_account_id: "0.0.9001",
          payer_account_id: "0.0.9001",
          consensus_timestamp: String(nowSec - 60),
          executed_timestamp: null,
          deleted: false,
          expiration_time: null,
          memo: "restock budget",
          transaction_body: Buffer.from(pendingBody).toString("base64"),
        },
        {
          schedule_id: "0.0.7000",
          creator_account_id: "0.0.9001",
          payer_account_id: "0.0.9001",
          consensus_timestamp: String(nowSec - 300),
          executed_timestamp: String(nowSec - 250),
          deleted: false,
          expiration_time: null,
          memo: "already done",
          transaction_body: Buffer.from(pendingBody).toString("base64"),
        },
        {
          schedule_id: "0.0.6999",
          creator_account_id: "0.0.9001",
          payer_account_id: "0.0.9001",
          consensus_timestamp: String(nowSec - 7200),
          executed_timestamp: null,
          deleted: false,
          expiration_time: null,
          memo: "expired long ago",
          transaction_body: Buffer.from(pendingBody).toString("base64"),
        },
      ],
    });
  }
  if (u.includes("/api/v1/accounts/0.0.9001")) {
    return json({
      account: "0.0.9001",
      deleted: false,
      key: { _type: "ProtobufEncoded", key: "32" },
      balance: { balance: 100 },
    });
  }
  if (u.includes(`/api/v1/accounts/${OWNER.evmAddress}`)) {
    return json({
      account: "0.0.111",
      evm_address: OWNER.evmAddress.toLowerCase(),
      balance: { balance: 0 },
    });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

test("getAgentRequests surfaces only live pending schedules, summarised from bytes", async () => {
  const agentStorage = new MemoryStorage();
  const wallet = new OculusVault({
    network: "testnet",
    keyProvider: {} as never,
    fetchImpl: scheduleMirrorStub as typeof fetch,
    agentStorage,
  });
  await wallet.unlockWithKey(OWNER.privateKeyHex, "42");
  const records: AgentRecord[] = [
    {
      accountId: "0.0.9001",
      name: "shopper",
      network: "testnet",
      agentPublicKeyHex: "02".repeat(33),
      frozen: false,
      createdAt: "2026-07-10T00:00:00.000Z",
    },
  ];
  await agentStorage.setItem(
    "oculusvault:agents:v1:42",
    JSON.stringify(encryptAgentRegistry(records, OWNER.privateKeyHex)),
  );

  const requests = await wallet.getAgentRequests();
  assert.equal(requests.length, 1, "executed + expired rows are filtered out");
  const r = requests[0]!;
  assert.equal(r.scheduleId, "0.0.7001");
  assert.equal(r.agentName, "shopper");
  assert.equal(r.involvesOwner, true);
  assert.equal(r.memo, "restock budget");
  assert.match(r.summary, /0\.50000000 ℏ from your balance → 0\.0\.9001/);
});
