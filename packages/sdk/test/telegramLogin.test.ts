import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { verifyTelegramLogin } from "../src/auth/telegramLogin.js";
import { InitDataError } from "../src/auth/initData.js";

const BOT_TOKEN = "123456:TEST_BOT_TOKEN_abcdefghijklmnop";
const nowSec = 1_900_000_000;
const fixedNow = () => nowSec * 1000;

/** Sign a payload the way the Telegram Login Widget does. */
function sign(fields: Record<string, string | number>, token = BOT_TOKEN) {
  const dcs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHash("sha256").update(token).digest();
  const hash = createHmac("sha256", secret).update(dcs).digest("hex");
  return { ...fields, hash };
}

const USER = { id: 42, first_name: "Ada", username: "ada", auth_date: nowSec - 10 };

test("accepts a correctly-signed login payload", () => {
  const result = verifyTelegramLogin(sign(USER), BOT_TOKEN, { now: fixedNow });
  assert.equal(result.user.id, 42);
  assert.equal(result.user.username, "ada");
});

test("rejects a tampered field", () => {
  const payload = { ...sign(USER), id: 99 };
  assert.throws(
    () => verifyTelegramLogin(payload, BOT_TOKEN, { now: fixedNow }),
    (e: unknown) => e instanceof InitDataError && e.code === "bad_signature",
  );
});

test("rejects the wrong bot token", () => {
  assert.throws(
    () => verifyTelegramLogin(sign(USER), "999:WRONG", { now: fixedNow }),
    (e: unknown) => e instanceof InitDataError && e.code === "bad_signature",
  );
});

test("rejects expired payloads", () => {
  const old = sign({ ...USER, auth_date: nowSec - 100_000 });
  assert.throws(
    () =>
      verifyTelegramLogin(old, BOT_TOKEN, { now: fixedNow, maxAgeSeconds: 3600 }),
    (e: unknown) => e instanceof InitDataError && e.code === "expired",
  );
});

test("rejects missing hash / missing id", () => {
  assert.throws(
    () => verifyTelegramLogin({ id: 1 } as any, BOT_TOKEN),
    (e: unknown) => e instanceof InitDataError && e.code === "missing_hash",
  );
  const noId = sign({ first_name: "X", auth_date: nowSec - 5 });
  assert.throws(
    () => verifyTelegramLogin(noId, BOT_TOKEN, { now: fixedNow }),
    (e: unknown) => e instanceof InitDataError && e.code === "missing_user",
  );
});
