import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyTelegramInitData,
  InitDataError,
} from "../src/auth/initData.js";

const BOT_TOKEN = "123456:TEST_BOT_TOKEN_abcdefghijklmnop";

/** Build a correctly-signed initData string for testing. */
function buildInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN,
): string {
  const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`);
  pairs.sort();
  const dataCheckString = pairs.join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(dataCheckString).digest("hex");
  const usp = new URLSearchParams(fields);
  usp.set("hash", hash);
  return usp.toString();
}

const nowSec = 1_900_000_000; // fixed clock
const fixedNow = () => nowSec * 1000;
const user = JSON.stringify({ id: 42, first_name: "Ada", username: "ada" });

test("accepts a correctly-signed initData", () => {
  const initData = buildInitData({
    user,
    auth_date: String(nowSec - 10),
    query_id: "abc",
  });
  const result = verifyTelegramInitData(initData, BOT_TOKEN, { now: fixedNow });
  assert.equal(result.user.id, 42);
  assert.equal(result.user.username, "ada");
});

test("rejects a tampered field", () => {
  const initData = buildInitData({
    user,
    auth_date: String(nowSec - 10),
  });
  // Tamper: swap the user to a different id after signing.
  const tampered = initData.replace(
    encodeURIComponent(user),
    encodeURIComponent(JSON.stringify({ id: 99, first_name: "Eve" })),
  );
  assert.throws(
    () => verifyTelegramInitData(tampered, BOT_TOKEN, { now: fixedNow }),
    (e: unknown) =>
      e instanceof InitDataError && e.code === "bad_signature",
  );
});

test("rejects the wrong bot token", () => {
  const initData = buildInitData({ user, auth_date: String(nowSec - 10) });
  assert.throws(
    () => verifyTelegramInitData(initData, "999:WRONG", { now: fixedNow }),
    (e: unknown) => e instanceof InitDataError && e.code === "bad_signature",
  );
});

test("rejects expired initData", () => {
  const initData = buildInitData({
    user,
    auth_date: String(nowSec - 100_000),
  });
  assert.throws(
    () =>
      verifyTelegramInitData(initData, BOT_TOKEN, {
        now: fixedNow,
        maxAgeSeconds: 3600,
      }),
    (e: unknown) => e instanceof InitDataError && e.code === "expired",
  );
});

test("rejects missing hash", () => {
  assert.throws(
    () => verifyTelegramInitData("user=" + encodeURIComponent(user), BOT_TOKEN),
    (e: unknown) => e instanceof InitDataError && e.code === "missing_hash",
  );
});
