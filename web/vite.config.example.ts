import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// このファイルをコピーして vite.config.ts を作成してください。
// cp vite.config.example.ts vite.config.ts
//
// 外部ホスト (Cloudflare Tunnel / Tailscale 等) からアクセスする場合は
// web/.env.local に VITE_ALLOWED_HOSTS を設定してください:
//
//   VITE_ALLOWED_HOSTS=concordia.example.com,ccm.example.com
//
// vite.config.ts はドメイン情報を含むため gitignore 対象です。

const extraHosts = process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? [];

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 17331,
    strictPort: true,
    allowedHosts: ["localhost", "127.0.0.1", ...extraHosts],
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
