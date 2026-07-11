import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// Configure env BEFORE importing the app (config reads it at module load).
const OCULUS_TOKEN = "111:oculus-bot-token";
const KICKOFF_TOKEN = "222:kickoff-bot-token";
const dataDir = mkdtempSync(join(tmpdir(), "ovault-test-"));
process.env.TELEGRAM_BOT_TOKEN = OCULUS_TOKEN;
process.env.TELEGRAM_BOT_TOKENS = JSON.stringify({ kickoff: KICKOFF_TOKEN });
process.env.SESSION_SECRET = "test-secret";
process.env.ALLOW_DEV_AUTH = "false";
process.env.VAULT_DATA_DIR = dataDir;

const NOW = 1_900_000_000_000;
const { createApp } = await import("../src/app.js");

let server: Server;
let base: string;

before(async () => {
  const app = createApp({ now: () => NOW });
  await new Promise<void>((r) => {
    server = app.listen(0, r);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/** Build a correctly-signed initData string for a given user + bot token. */
function buildInitData(userId: number, token: string): string {
  const fields: Record<string, string> = {
    user: JSON.stringify({ id: userId, username: `u${userId}` }),
    auth_date: String(Math.floor(NOW / 1000) - 10),
  };
  const dcs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  const usp = new URLSearchParams(fields);
  usp.set("hash", hash);
  return usp.toString();
}

async function login(userId: number, token: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: buildInitData(userId, token) }),
  });
  assert.equal(res.status, 200, `login ${userId} should succeed`);
  return (await res.json()).token as string;
}

const FAKE_RECORD = JSON.stringify({
  version: 1,
  evmAddress: "0xabc",
  ciphertext: "ZmFrZS1jaXBoZXJ0ZXh0",
  nonce: "ZmFrZS1ub25jZQ",
  kdf: { algorithm: "argon2id", salt: "s" },
});

test("dev auth is disabled here (forged initData rejected)", async () => {
  const res = await fetch(`${base}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initData: "user=%7B%22id%22%3A1%7D&hash=dead" }),
  });
  assert.equal(res.status, 401);
});

test("the SAME Telegram user shares ONE vault across different bots", async () => {
  const oculusToken = await login(42, OCULUS_TOKEN);
  // store via the OculusVault bot session
  const put = await fetch(`${base}/api/vault`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${oculusToken}` },
    body: JSON.stringify({ record: FAKE_RECORD }),
  });
  assert.equal(put.status, 200);

  // same human (uid 42) logs in via the KICKOFF bot — must see the same record
  const kickoffToken = await login(42, KICKOFF_TOKEN);
  const get = await fetch(`${base}/api/vault`, {
    headers: { authorization: `Bearer ${kickoffToken}` },
  });
  assert.equal(get.status, 200);
  assert.equal((await get.json()).record, FAKE_RECORD);
});

test("a different user cannot read someone else's vault", async () => {
  const other = await login(777, OCULUS_TOKEN);
  const res = await fetch(`${base}/api/vault`, {
    headers: { authorization: `Bearer ${other}` },
  });
  assert.equal(res.status, 404);
});

test("unauthenticated vault access is rejected", async () => {
  const res = await fetch(`${base}/api/vault`);
  assert.equal(res.status, 401);
});

test("rejects an upload that is not an encrypted record", async () => {
  const token = await login(55, OCULUS_TOKEN);
  const res = await fetch(`${base}/api/vault`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ record: "my-plaintext-private-key" }),
  });
  assert.equal(res.status, 422);
});

test("Login Widget auth (extension) opens the SAME vault as Mini App auth", async () => {
  // Store a record via Mini App-style initData auth…
  const miniAppToken = await login(4242, OCULUS_TOKEN);
  await fetch(`${base}/api/vault`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${miniAppToken}` },
    body: JSON.stringify({ record: FAKE_RECORD }),
  });

  // …then log in as the SAME user via the Telegram Login Widget scheme.
  const fields: Record<string, string | number> = {
    id: 4242,
    first_name: "Ada",
    username: "u4242",
    auth_date: Math.floor(NOW / 1000) - 10,
  };
  const dcs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHash("sha256").update(OCULUS_TOKEN).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");

  const loginRes = await fetch(`${base}/api/auth/telegram-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: { ...fields, hash } }),
  });
  assert.equal(loginRes.status, 200);
  const { token: widgetToken, userId } = await loginRes.json();
  assert.equal(userId, "4242");

  const get = await fetch(`${base}/api/vault`, {
    headers: { authorization: `Bearer ${widgetToken}` },
  });
  assert.equal(get.status, 200);
  assert.equal((await get.json()).record, FAKE_RECORD);

  // Forged widget payloads are rejected.
  const forged = await fetch(`${base}/api/auth/telegram-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ data: { ...fields, hash: "deadbeef".repeat(8) } }),
  });
  assert.equal(forged.status, 401);
});

test("agents slot is independent of the wallet slot", async () => {
  const token = await login(88, OCULUS_TOKEN);
  // Nothing in either slot yet.
  const emptyAgents = await fetch(`${base}/api/vault/agents`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(emptyAgents.status, 404);

  // Writing the WALLET slot must not create the AGENTS slot…
  await fetch(`${base}/api/vault`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ record: FAKE_RECORD }),
  });
  const stillEmpty = await fetch(`${base}/api/vault/agents`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(stillEmpty.status, 404);

  // …and the agents slot stores its own ciphertext.
  const AGENTS_RECORD = JSON.stringify({
    version: 1,
    ciphertext: "YWdlbnRzLWNpcGhlcnRleHQ",
    nonce: "YWdlbnRzLW5vbmNl",
  });
  const put = await fetch(`${base}/api/vault/agents`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ record: AGENTS_RECORD }),
  });
  assert.equal(put.status, 200);
  const got = await fetch(`${base}/api/vault/agents`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await got.json()).record, AGENTS_RECORD);
  const wallet = await fetch(`${base}/api/vault`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await wallet.json()).record, FAKE_RECORD);

  // Same encrypted-only rule applies to the agents slot.
  const plaintext = await fetch(`${base}/api/vault/agents`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ record: JSON.stringify({ agents: ["0.0.1"] }) }),
  });
  assert.equal(plaintext.status, 422);

  // Other users can't see it; unauthenticated access is rejected.
  const other = await login(89, OCULUS_TOKEN);
  const foreign = await fetch(`${base}/api/vault/agents`, {
    headers: { authorization: `Bearer ${other}` },
  });
  assert.equal(foreign.status, 404);
  const anon = await fetch(`${base}/api/vault/agents`);
  assert.equal(anon.status, 401);
});

test("agent watch list accepts valid ids, rejects junk, requires auth", async () => {
  const token = await login(90, OCULUS_TOKEN);
  const put = (body: unknown, auth = true) =>
    fetch(`${base}/api/notify/agents`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(auth ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal((await put({ accountIds: ["0.0.555", "0.0.556"] })).status, 200);
  assert.equal((await put({ accountIds: [] })).status, 200); // clears
  assert.equal((await put({ accountIds: ["not-an-id"] })).status, 400);
  assert.equal((await put({ accountIds: "0.0.555" })).status, 400);
  assert.equal((await put({}, false)).status, 401);
});

test("delete removes the record", async () => {
  const token = await login(42, OCULUS_TOKEN);
  const del = await fetch(`${base}/api/vault`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(del.status, 200);
  const get = await fetch(`${base}/api/vault`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(get.status, 404);
});
