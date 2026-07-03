import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the popup; manifest.json, background.js and icons ship via public/.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    fs: { allow: ["../.."] }, // let dev serve the shared miniapp styles
  },
  define: {
    global: "globalThis",
  },
  build: {
    rollupOptions: {
      input: "popup.html",
    },
  },
});
