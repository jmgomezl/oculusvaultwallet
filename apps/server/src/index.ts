/** Entry point: build the app and listen. See app.ts for the routes. */
import { config, assertProdSafety } from "./config.js";
import { createApp } from "./app.js";

assertProdSafety();
createApp().listen(config.port, () => {
  console.log(
    `oculusvault server on :${config.port} (network=${config.network}, apps=${Object.keys(
      config.botTokens,
    ).join(",")})`,
  );
});
