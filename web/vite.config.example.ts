import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// このファイルをコピーして vite.config.ts を作成してください。
// cp vite.config.example.ts vite.config.ts
//
// 外部ホスト (Cloudflare Tunnel / Tailscale 等) は concordia.config.json の
// web.allowedHosts に追加してください (設定 UI からも変更可):
//
//   { "web": { "allowedHosts": ["concordia.example.com"] } }
//
// env override: web/.env.local に VITE_ALLOWED_HOSTS=host1,host2 を設定しても可。
// vite.config.ts はドメイン情報を含むため gitignore 対象です。

function loadConfigHosts(): string[] {
  const path = resolve(process.cwd(), "../concordia.config.json");
  if (!existsSync(path)) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { web?: { allowedHosts?: unknown } };
    const hosts = cfg?.web?.allowedHosts;
    return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === "string") : [];
  } catch { return []; }
}

const configHosts = loadConfigHosts();
const envHosts = process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? [];

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 17331,
    strictPort: true,
    allowedHosts: ["localhost", "127.0.0.1", ...configHosts, ...envHosts],
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
