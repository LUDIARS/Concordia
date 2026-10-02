import { serve, type HttpBindings } from "@hono/node-server";
import type { Context } from "hono";
import type { Server } from "node:http";
import { managementRemoteApp } from "../api/management.js";
import { AuthFailureLimiter } from "./auth-failure-limiter.js";
import { CfAccessVerifier, type JwksFetcher } from "./cf-access.js";
import { REMOTE_MAX_BODY_BYTES, type ManagementRemoteConfig } from "./remote-config.js";
import type { ManagementService } from "./service.js";

/**
 * dots 専用の入口 (CC-MGMT-07)。 Cc 本体の HTTP とは別の node:http サーバと別ポートで立て、
 * dots の 6 操作だけを載せる。 TLS は前段 (Tailscale 等) で終端する。
 */

export interface ManagementRemoteHandle {
  host: string;
  port: number;
  close: () => Promise<void>;
}

function remoteOf(c: Context): string {
  const bindings = c.env as Partial<HttpBindings> | undefined;
  return bindings?.incoming?.socket?.remoteAddress ?? "unknown";
}

export function startManagementRemoteListener(
  config: ManagementRemoteConfig,
  service: ManagementService,
  limiter = new AuthFailureLimiter(),
  fetchJwks?: JwksFetcher,
): Promise<ManagementRemoteHandle> {
  const verifier = config.publicAccess?.access ? new CfAccessVerifier(config.publicAccess.access, fetchJwks) : null;
  const app = managementRemoteApp(service, {
    isLimited: (c) => limiter.isLimited(remoteOf(c)),
    recordFailure: (c) => limiter.recordFailure(remoteOf(c)),
  }, REMOTE_MAX_BODY_BYTES, config.publicAccess
    // Access 未設定の間は公開 Host 宛てを全部拒否する (検証なしで通さない)。
    ? { host: config.publicAccess.host, verify: async (assertion) => (verifier ? verifier.verify(assertion) : null) }
    : undefined);
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }) as Server;
    const pruneTimer = setInterval(() => limiter.prune(), 60_000);
    pruneTimer.unref();
    const onError = (error: Error) => {
      clearInterval(pruneTimer);
      server.close();
      reject(error);
    };
    server.once("error", onError);
    server.once("listening", () => {
      server.off("error", onError);
      server.on("error", () => { /* 稼働後のソケットエラーは個々の接続に閉じる */ });
      const address = server.address();
      resolve({
        host: config.host,
        // port 0 (テスト) のときは実際に割り当てられたポートを返す。
        port: typeof address === "object" && address ? address.port : config.port,
        close: () => new Promise<void>((done) => {
          clearInterval(pruneTimer);
          server.close(() => done());
          server.closeAllConnections?.();
        }),
      });
    });
  });
}
