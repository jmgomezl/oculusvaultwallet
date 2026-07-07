import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AccountId,
  Hbar,
  TokenAssociateTransaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { describeTransaction } from "../src/hedera/describe.js";

test("describes an HBAR transfer with amounts and memo", () => {
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString("0.0.111"), new Hbar(-5))
    .addHbarTransfer(AccountId.fromString("0.0.222"), new Hbar(5))
    .setTransactionMemo("lunch");
  const s = describeTransaction(tx);
  assert.match(s, /^Transfer — /);
  assert.match(s, /0\.0\.111 -5\.00000000 ℏ/);
  assert.match(s, /0\.0\.222 \+5\.00000000 ℏ/);
  assert.match(s, /memo: “lunch”/);
});

test("describes non-transfer transactions by their type", () => {
  const tx = new TokenAssociateTransaction();
  assert.equal(describeTransaction(tx), "Token associate");
});
