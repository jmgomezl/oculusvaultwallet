import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The backend URL the Mini App talks to. Override with VITE_API_BASE.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // expose on LAN so a phone / tunnel can reach it
    port: 5173,
  },
  define: {
    // @hashgraph/sdk and some deps expect a global in browser contexts.
    global: "globalThis",
  },
});
