import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encryptAgentRegistry,
  decryptAgentRegistry,
  type AgentRecord,
} from "../src/agentRegistry.js";
import { generateKey } from "../src/crypto/keys.js";
import { agentKeyList, createAgentAccount } from "../src/hedera/agents.js";
import { MirrorClient } from "../src/hedera/mirror.js";
import { getNetworkConfig } from "../src/hedera/networks.js";
import { MemoryStorage } from "../src/storage/Storage.js";
import { OculusVault } from "../src/wallet.js";
import { PrivateKey } from "@hashgraph/sdk";

const OWNER = generateKey();

const AGENTS: AgentRecord[] = [
  {
    accountId: "0.0.9001",
    name: "shopper",
    network: "testnet",
    agentPublicKeyHex: "02".repeat(33),
    frozen: false,
    createdAt: "2026-07-10T00:00:00.000Z",
  },
  {
    accountId: "0.0.9002",
    name: "researcher",
    network: "testnet",
    agentPublicKeyHex: "03".repeat(33),
    frozen: false,
    createdAt: "2026-07-10T00:00:00.000Z",
  },
];

test("agent registry: encrypt/decrypt roundtrip with the wallet key", () => {
  const encrypted = encryptAgentRegistry(AGENTS, OWNER.privateKeyHex);
  // The record must look like vault ciphertext (server-side validation).
  assert.equal(encrypted.version, 1);
  assert.ok(encrypted.ciphertext.length > 0);
  assert.ok(encrypted.nonce.length > 0);
  assert.ok(!JSON.stringify(encrypted).includes("shopper"), "names must not leak");
  const decrypted = decryptAgentRegistry(encrypted, OWNER.privateKeyHex);
  assert.deepEqual(decrypted, AGENTS);
});

test("agent registry: a different wallet key cannot decrypt", () => {
  const encrypted = encryptAgentRegistry(AGENTS, OWNER.privateKeyHex);
  const stranger = generateKey();
  assert.throws(
    () => decryptAgentRegistry(encrypted, stranger.privateKeyHex),
    /wrong wallet key or corrupted/,
  );
});

test("agent registry: tampered ciphertext fails authentication", () => {
  const encrypted = encryptAgentRegistry(AGENTS, OWNER.privateKeyHex);
  const tampered = {
    ...encrypted,
    ciphertext: encrypted.ciphertext.slice(0, -2) + "AA",
  };
  assert.throws(
    () => decryptAgentRegistry(tampered, OWNER.privateKeyHex),
    /wrong wallet key or corrupted/,
  );
});

test("agentKeyList is a 1-of-2 threshold over [owner, agent]", () => {
  const owner = PrivateKey.generateECDSA();
  const agent = PrivateKey.generateECDSA();
  const list = agentKeyList(owner.publicKey, agent.publicKey);
  assert.equal(list.threshold, 1);
  assert.equal(list.toArray().length, 2);
});

test("createAgentAccount rejects a non-positive initial balance", async () => {
  await assert.rejects(
    createAgentAccount({
      network: "testnet",
      ownerAccountId: "0.0.111",
      ownerPrivateKeyHex: OWNER.privateKeyHex,
      initialHbar: "0",
    }),
    /positive HBAR amount/,
  );
});

/** Mirror stub: 0.0.9001 is an active KeyList account, 0.0.9002 was frozen
 * (simple key), 0.0.9003 was deleted, anything else 404s. */
function agentMirrorStub(url: RequestInfo | URL): Promise<Response> {
  const u = String(url);
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  if (u.includes("/api/v1/accounts/0.0.9001")) {
    return json({
      account: "0.0.9001",
      deleted: false,
      key: { _type: "ProtobufEncoded", key: "326c..." },
      balance: { balance: 250_000_000 },
    });
  }
  if (u.includes("/api/v1/accounts/0.0.9002")) {
    return json({
      account: "0.0.9002",
      deleted: false,
      key: { _type: "ECDSA_SECP256K1", key: "02ab" },
      balance: { balance: 100_000_000 },
    });
  }
  if (u.includes("/api/v1/accounts/0.0.9003")) {
    return json({
      account: "0.0.9003",
      deleted: true,
      key: { _type: "ECDSA_SECP256K1", key: "02ab" },
      balance: { balance: 0 },
    });
  }
  if (u.includes(`/api/v1/accounts/${OWNER.evmAddress}`)) {
    return json({
      account: "0.0.111",
      evm_address: OWNER.evmAddress.toLowerCase(),
      balance: { balance: 1_000_000_000 },
    });
  }
  if (u.includes("/api/v1/network/exchangerate")) {
    return json({ current_rate: { hbar_equivalent: 1, cent_equivalent: 20 } });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

test("MirrorClient.getAccountFlags reads key structure and deleted flag", async () => {
  const mirror = new MirrorClient(
    getNetworkConfig("testnet"),
    agentMirrorStub as typeof fetch,
  );
  const active = await mirror.getAccountFlags("0.0.9001");
  assert.equal(active?.keyIsComplex, true);
  assert.equal(active?.deleted, false);
  assert.equal(active?.balanceTinybar, 250_000_000n);
  const frozen = await mirror.getAccountFlags("0.0.9002");
  assert.equal(frozen?.keyIsComplex, false);
  const gone = await mirror.getAccountFlags("0.0.9404");
  assert.equal(gone, null);
});

test("listAgents reconciles registry records against on-chain key state", async () => {
  const agentStorage = new MemoryStorage();
  const wallet = new OculusVault({
    network: "testnet",
    keyProvider: {} as never, // unlockWithKey path — provider never touched
    fetchImpl: agentMirrorStub as typeof fetch,
    agentStorage,
  });
  await wallet.unlockWithKey(OWNER.privateKeyHex, "42");

  // Seed the registry as a UI session would have left it. The stored `frozen`
  // hints are stale on purpose — the chain must win.
  const seeded: AgentRecord[] = [
    { ...AGENTS[0]!, frozen: true }, // chain says KeyList → active
    { ...AGENTS[1]!, accountId: "0.0.9002", frozen: false }, // chain says simple key → frozen
    {
      accountId: "0.0.9003",
      name: "old-bot",
      network: "testnet",
      agentPublicKeyHex: "04".repeat(33),
      frozen: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    }, // chain says deleted → retired
    {
      accountId: "0.0.5555",
      name: "mainnet-bot",
      network: "mainnet",
      agentPublicKeyHex: "05".repeat(33),
      frozen: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    }, // other network → filtered out
  ];
  await agentStorage.setItem(
    "oculusvault:agents:v1:42",
    JSON.stringify(encryptAgentRegistry(seeded, OWNER.privateKeyHex)),
  );

  const views = await wallet.listAgents();
  assert.equal(views.length, 3, "mainnet agent must not appear on testnet");
  const byId = new Map(views.map((v) => [v.accountId, v]));
  assert.equal(byId.get("0.0.9001")?.status, "active");
  assert.equal(byId.get("0.0.9001")?.balanceHbar, "2.50000000");
  assert.equal(byId.get("0.0.9002")?.status, "frozen");
  assert.equal(byId.get("0.0.9003")?.status, "retired");
});

test("agent methods are gated on configuration and name validation", async () => {
  const noDesk = new OculusVault({
    network: "testnet",
    keyProvider: {} as never,
    fetchImpl: agentMirrorStub as typeof fetch,
  });
  await noDesk.unlockWithKey(OWNER.privateKeyHex, "42");
  assert.equal(noDesk.agentsEnabled, false);
  await assert.rejects(noDesk.listAgents(), /no agent storage configured/);

  const desk = new OculusVault({
    network: "testnet",
    keyProvider: {} as never,
    fetchImpl: agentMirrorStub as typeof fetch,
    agentStorage: new MemoryStorage(),
  });
  await desk.unlockWithKey(OWNER.privateKeyHex, "42");
  assert.equal(desk.agentsEnabled, true);
  await assert.rejects(desk.createAgent("   ", 1), /1–40 characters/);
  await assert.rejects(desk.unfreezeAgent("0.0.9999"), /isn't in your registry/);
});

test("createAgentAuditTopic guards: unknown agent / already has a logbook", async () => {
  const agentStorage = new MemoryStorage();
  const wallet = new OculusVault({
    network: "testnet",
    keyProvider: {} as never,
    fetchImpl: agentMirrorStub as typeof fetch,
    agentStorage,
  });
  await wallet.unlockWithKey(OWNER.privateKeyHex, "42");
  await agentStorage.setItem(
    "oculusvault:agents:v1:42",
    JSON.stringify(
      encryptAgentRegistry(
        [
          { ...AGENTS[0]! },
          { ...AGENTS[1]!, auditTopicId: "0.0.4242" },
        ],
        OWNER.privateKeyHex,
      ),
    ),
  );
  await assert.rejects(wallet.createAgentAuditTopic("0.0.404"), /isn't in your registry/);
  await assert.rejects(
    wallet.createAgentAuditTopic("0.0.9002"),
    /already has an audit log \(topic 0\.0\.4242\)/,
  );
});
