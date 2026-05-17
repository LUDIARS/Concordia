import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 17331,
    strictPort: true,
    allowedHosts: ["concordia.vtn-game.com", "localhost", "127.0.0.1"],
    proxy: {
      "/v1": "http://127.0.0.1:17330",
      "/health": "http://127.0.0.1:17330",
      // observability router (Excubitor 由来) は /api/v1/... を持つ. Catalog / Errors /
      // Reviews ページがこの prefix で fetch するので proxy 必須.
      "/api": "http://127.0.0.1:17330",
      // WS broadcast endpoint (/ws). Vite が upgrade を pass-through する.
      "/ws": { target: "ws://127.0.0.1:17330", ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
