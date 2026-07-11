/** Entry point: build the app and listen. See app.ts for the routes. */
import { join } from "node:path";
import { MirrorClient, getNetworkConfig } from "@oculusvault/sdk";
import { config, assertProdSafety } from "./config.js";
import { createApp } from "./app.js";
import { createNotifier } from "./notifier.js";
import { VaultStore } from "./vaultStore.js";

assertProdSafety();
const vault = new VaultStore(config.vaultDataDir);
const agentWatch = new VaultStore(config.vaultDataDir, "agent-watch.json");
createApp({ vault, agentWatch }).listen(config.port, () => {
  console.log(
    `oculusvault server on :${config.port} (network=${config.network}, apps=${Object.keys(
      config.botTokens,
    ).join(",")}, notify=${config.notifyEnabled})`,
  );
});

if (config.notifyEnabled && config.botToken !== "PLACEHOLDER_BOT_TOKEN") {
  createNotifier({
    vault,
    agentWatch,
    mirror: new MirrorClient(getNetworkConfig(config.network)),
    botToken: config.botToken,
    cursorFile: join(config.vaultDataDir, "notify-cursors.json"),
  }).start(config.notifyIntervalMs);
}
