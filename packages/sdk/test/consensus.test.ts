import { test } from "node:test";
import assert from "node:assert/strict";
import { MirrorClient } from "../src/hedera/mirror.js";
import { getNetworkConfig } from "../src/hedera/networks.js";

function hcsFetchStub(url: RequestInfo | URL): Promise<Response> {
  const u = String(url);
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  if (u.includes("transactiontype=CONSENSUSCREATETOPIC")) {
    return json({
      transactions: [
        {
          transaction_id: "0.0.111@1700000010.000000000",
          consensus_timestamp: "1700000010.000000000",
          entity_id: "0.0.777",
        },
        // A failed/duplicate row without an entity id must be skipped.
        { transaction_id: "x", consensus_timestamp: "1700000011.0", entity_id: null },
      ],
    });
  }
  if (u.includes("/api/v1/topics/0.0.777/messages")) {
    return json({
      messages: [
        {
          sequence_number: 2,
          consensus_timestamp: "1700000020.000000001",
          // base64("second stamp ✓")
          message: Buffer.from("second stamp ✓", "utf8").toString("base64"),
        },
        {
          sequence_number: 1,
          consensus_timestamp: "1700000015.000000001",
          message: Buffer.from("hello notary", "utf8").toString("base64"),
        },
      ],
    });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

test("getCreatedTopics lists topics from creation history", async () => {
  const mirror = new MirrorClient(
    getNetworkConfig("testnet"),
    hcsFetchStub as typeof fetch,
  );
  const topics = await mirror.getCreatedTopics("0.0.111");
  assert.equal(topics.length, 1);
  assert.equal(topics[0]!.topicId, "0.0.777");
});

test("getTopicMessages decodes base64 UTF-8 with timestamps", async () => {
  const mirror = new MirrorClient(
    getNetworkConfig("testnet"),
    hcsFetchStub as typeof fetch,
  );
  const msgs = await mirror.getTopicMessages("0.0.777");
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0]!.sequenceNumber, 2);
  assert.equal(msgs[0]!.message, "second stamp ✓");
  assert.equal(msgs[1]!.message, "hello notary");
  assert.match(msgs[0]!.timestamp, /^2023-/);
});
