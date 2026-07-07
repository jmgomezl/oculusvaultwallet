import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVM_CHAIN_IDS,
  entityEvmAddress,
  erc20TransferData,
  hbarToWeibar,
  weibarToHbar,
} from "../src/hedera/evm.js";

test("weibar conversions are exact 18-decimal bigints", () => {
  assert.equal(hbarToWeibar("1.5"), 1_500_000_000_000_000_000n);
  assert.equal(hbarToWeibar("0.00000001"), 10_000_000_000n); // 1 tinybar
  assert.equal(weibarToHbar(1_500_000_000_000_000_000n), "1.5");
  assert.equal(weibarToHbar(hbarToWeibar("123.45678901")), "123.45678901");
  assert.throws(() => hbarToWeibar("1.1234567890123456789"), /decimal places/);
});

test("entityEvmAddress builds the long-zero form", () => {
  // 429274 = 0x68cda → left-padded to 20 bytes
  assert.equal(
    entityEvmAddress("0.0.429274"),
    "0x0000000000000000000000000000000000068cda",
  );
  assert.equal(entityEvmAddress("0.0.429274").length, 42);
  assert.throws(() => entityEvmAddress("429274"), /Not a Hedera entity id/);
});

test("erc20TransferData encodes transfer(address,uint256)", () => {
  const data = erc20TransferData(
    "0xC9AA0BBE8C14242CE8128EA95756640B582FD706",
    12_345n,
  );
  assert.equal(data.length, 2 + 8 + 64 + 64);
  assert.ok(data.startsWith("0xa9059cbb"));
  assert.ok(
    data.includes("000000000000000000000000c9aa0bbe8c14242ce8128ea95756640b582fd706"),
  );
  assert.ok(data.endsWith("3039")); // 12345 = 0x3039
  assert.throws(() => erc20TransferData("0.0.222", 1n), /Not an EVM address/);
  assert.throws(
    () => erc20TransferData("0xC9AA0BBE8C14242CE8128EA95756640B582FD706", 0n),
    /positive/,
  );
});

test("relay chain ids match HIP-30 registrations", () => {
  assert.deepEqual(EVM_CHAIN_IDS, { mainnet: 295, testnet: 296, previewnet: 297 });
});
