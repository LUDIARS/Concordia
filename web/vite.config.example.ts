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

// concordia.config.json (非シークレット設定の正本) を読む。 web.port / web.allowedHosts と
// backend の server.port をここから取得する (env を使わない方針)。
function loadServerConfig(): {
  hosts: string[];
  webPort?: number;
  backendPort?: number;
} {
  const path = resolve(process.cwd(), "../concordia.config.json");
  if (!existsSync(path)) return { hosts: [] };
  const cfg = JSON.parse(readFileSync(path, "utf8")) as {
    server?: { port?: unknown };
    web?: { allowedHosts?: unknown; port?: unknown };
  };
  const rawHosts = cfg?.web?.allowedHosts;
  const hosts = Array.isArray(rawHosts)
    ? rawHosts.filter((h): h is string => typeof h === "string")
    : [];
  const webPort = typeof cfg?.web?.port === "number" ? cfg.web.port : undefined;
  const backendPort = typeof cfg?.server?.port === "number" ? cfg.server.port : undefined;
  return { hosts, webPort, backendPort };
}

const serverConfig = loadServerConfig();
const configHosts = serverConfig.hosts;
const webPort = serverConfig.webPort ?? 10101;
const backendPort = serverConfig.backendPort ?? 11111;
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const envHosts = process.env.VITE_ALLOWED_HOSTS?.split(",").filter(Boolean) ?? [];

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: webPort,
    strictPort: true,
    allowedHosts: ["localhost", "127.0.0.1", ...configHosts, ...envHosts],
    proxy: {
      "/v1": backendOrigin,
      "/health": backendOrigin,
      // observability router (Excubitor 由来) は /api/v1/... を持つ. Catalog / Errors /
      // Reviews ページがこの prefix で fetch するので proxy 必須.
      "/api": backendOrigin,
      // WS broadcast endpoint (/ws). Vite が upgrade を pass-through する.
      "/ws": { target: `ws://127.0.0.1:${backendPort}`, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
