import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parsePayIntent,
  buildPayParam,
  buildPayLink,
} from "../src/payIntent.js";

const EVM = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";

test("parses pay_<evm>_<amount> with dash decimal", () => {
  assert.deepEqual(parsePayIntent(`pay_${EVM}_1-5`), {
    to: EVM,
    amountHbar: "1.5",
  });
});

test("parses pay_<evm> without amount", () => {
  const intent = parsePayIntent(`pay_${EVM}`);
  assert.equal(intent?.to, EVM);
  assert.equal(intent?.amountHbar, undefined);
});

test("parses dashed account id (startapp-safe 0-0-x)", () => {
  assert.deepEqual(parsePayIntent("pay_0-0-9287437_5"), {
    to: "0.0.9287437",
    amountHbar: "5",
  });
});

test("parses to_<addr> and bare addresses", () => {
  assert.equal(parsePayIntent(`to_${EVM}`)?.to, EVM);
  assert.equal(parsePayIntent(EVM)?.to, EVM);
  assert.equal(parsePayIntent("0.0.1234")?.to, "0.0.1234");
});

test("parses a full t.me deep link", () => {
  const link = buildPayLink("OculusVaultBot", EVM, 2.5);
  const intent = parsePayIntent(link);
  assert.deepEqual(intent, { to: EVM, amountHbar: "2.5" });
});

test("round-trips account ids through buildPayParam", () => {
  assert.equal(buildPayParam("0.0.1234", "0.1"), "pay_0-0-1234_0-1");
  assert.deepEqual(parsePayIntent(buildPayParam("0.0.1234", "0.1")), {
    to: "0.0.1234",
    amountHbar: "0.1",
  });
});

test("token pay intents: build + parse round-trip", () => {
  // Amount + token
  assert.equal(
    buildPayParam(EVM, "1.5", "0.0.429274"),
    `pay_${EVM}_1-5_t429274`,
  );
  assert.deepEqual(parsePayIntent(`pay_${EVM}_1-5_t429274`), {
    to: EVM,
    amountHbar: "1.5",
    tokenId: "0.0.429274",
  });
  // Token without amount
  assert.deepEqual(parsePayIntent(buildPayParam("0.0.1234", undefined, "0.0.456858")), {
    to: "0.0.1234",
    amountHbar: undefined,
    tokenId: "0.0.456858",
  });
  // Full deep link carries the token through
  const link = buildPayLink("OculusVaultBot", EVM, "2.5", "0.0.429274");
  assert.equal(parsePayIntent(link)?.tokenId, "0.0.429274");
  // Invalid token id refuses to build
  assert.throws(() => buildPayParam(EVM, "1", "429274"), /Invalid token id/);
  // Unknown future segments are ignored, not fatal
  assert.equal(parsePayIntent(`pay_${EVM}_1-5_x9z`)?.amountHbar, "1.5");
});

test("rejects garbage, zero amounts, and non-addresses", () => {
  assert.equal(parsePayIntent("hello world"), null);
  assert.equal(parsePayIntent("pay_notanaddress_5"), null);
  assert.equal(parsePayIntent(""), null);
  // zero amount → treated as no amount, address still honoured
  assert.deepEqual(parsePayIntent(`pay_${EVM}_0`), { to: EVM, amountHbar: undefined });
});
