import { test } from "node:test";
import assert from "node:assert/strict";
import { MirrorClient } from "../src/hedera/mirror.js";
import { getNetworkConfig } from "../src/hedera/networks.js";

function stakingFetchStub(url: RequestInfo | URL): Promise<Response> {
  const u = String(url);
  const json = (body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  if (u.includes("/api/v1/network/nodes")) {
    return json({
      nodes: [
        { node_id: 0, description: "Hosted by LG" },
        { node_id: 3, description: "Hosted by Wipro" },
      ],
    });
  }
  if (u.includes("/api/v1/accounts/0.0.111")) {
    return json({
      account: "0.0.111",
      staked_node_id: 3,
      pending_reward: 123456789,
      decline_reward: false,
      balance: { balance: 0 },
    });
  }
  if (u.includes("/api/v1/accounts/0.0.222")) {
    return json({
      account: "0.0.222",
      staked_node_id: null,
      pending_reward: 0,
      decline_reward: false,
      balance: { balance: 0 },
    });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

test("getStakingInfo reads node, pending reward, decline flag", async () => {
  const mirror = new MirrorClient(
    getNetworkConfig("testnet"),
    stakingFetchStub as typeof fetch,
  );
  const staking = await mirror.getStakingInfo("0.0.111");
  assert.deepEqual(staking, {
    stakedNodeId: 3,
    pendingRewardTinybar: 123456789n,
    pendingRewardHbar: "1.23456789",
    declineReward: false,
  });
  const none = await mirror.getStakingInfo("0.0.222");
  assert.equal(none.stakedNodeId, null);
  assert.equal(none.pendingRewardHbar, "0.00000000");
});

test("getNetworkNodes lists stakeable nodes", async () => {
  const mirror = new MirrorClient(
    getNetworkConfig("testnet"),
    stakingFetchStub as typeof fetch,
  );
  const nodes = await mirror.getNetworkNodes();
  assert.deepEqual(nodes, [
    { nodeId: 0, description: "Hosted by LG" },
    { nodeId: 3, description: "Hosted by Wipro" },
  ]);
});
