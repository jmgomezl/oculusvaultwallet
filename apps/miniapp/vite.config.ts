import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// The backend URL the Mini App talks to. Override with VITE_API_BASE.
export default defineConfig({
  plugins: [
    react(),
    // The Ledger transport stack (hardware.html entry) expects Buffer/process.
    nodePolyfills({ globals: { Buffer: true, process: true }, protocolImports: false }),
  ],
  server: {
    host: true, // expose on LAN so a phone / tunnel can reach it
    port: 5173,
  },
  define: {
    // @hashgraph/sdk and some deps expect a global in browser contexts.
    global: "globalThis",
    // Visible in the footer — lets us tell which build a device is running
    // (Telegram webviews cache aggressively).
    __BUILD_ID__: JSON.stringify(
      new Date().toISOString().slice(0, 16).replace("T", " ") + "Z",
    ),
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        // Desktop Ledger page — WebHID needs a real browser tab, not a webview.
        hardware: resolve(__dirname, "hardware.html"),
      },
    },
  },
});
