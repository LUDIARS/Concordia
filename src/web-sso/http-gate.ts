/**
 * 公開ホストの判定を HTTP (Hono) と WS (node:http の upgrade) に配線する。
 * 判定そのものは gate.ts、ここは入出力の変換だけ。
 */

import type { IncomingMessage } from "node:http";
import type { MiddlewareHandler } from "hono";
import { createChildLogger } from "../shared/logger.js";
import { CernereProjectChannel } from "./cernere-project-channel.js";
import type { WebSsoConfig } from "./config.js";
import { EnterpriseSessionClient } from "./enterprise-session-client.js";
import { decideAccess, type GateDecision, type GateOptions } from "./gate.js";

const log = createChildLogger("web-sso");

export interface WebSsoGate {
  decide(header: (name: string) => string | undefined | null, allowLogin: boolean): Promise<GateDecision>;
  close(): void;
}

export function createWebSsoGate(config: WebSsoConfig): WebSsoGate {
  const channel = new CernereProjectChannel(config);
  const client = new EnterpriseSessionClient(channel);
  return {
    decide: (header, allowLogin) => decideAccess(header, {
      publicHost: config.publicHost,
      projectKey: config.projectKey,
      client,
      allowLogin,
    } satisfies GateOptions),
    close: () => channel.close(),
  };
}

export function webSsoMiddleware(gate: WebSsoGate): MiddlewareHandler {
  return async (c, next) => {
    const decision = await gate.decide((name) => c.req.header(name), true);
    if (decision.kind === "local") return next();
    if (decision.kind === "deny") {
      log.warn({ path: c.req.path, status: decision.status }, "public host request denied");
      const res = c.text(decision.reason, decision.status);
      if (decision.setCookie) res.headers.append("set-cookie", decision.setCookie);
      res.headers.set("cache-control", "no-store");
      return res;
    }
    await next();
    if (!decision.setCookie) return;
    // 静的配信などの Response は headers が不変のことがあるので、包み直してから付ける。
    const res = new Response(c.res.body, c.res);
    res.headers.append("set-cookie", decision.setCookie);
    c.res = res;
  };
}

/** WS upgrade の判定。Cookie を発行できないので login はしない (先に HTTP で画面を開いている前提)。 */
export async function webSsoAllowsUpgrade(gate: WebSsoGate, req: IncomingMessage): Promise<{ ok: true } | { ok: false; status: number }> {
  const decision = await gate.decide((name) => {
    const value = req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value.join(", ") : value;
  }, false);
  if (decision.kind === "deny") {
    log.warn({ status: decision.status }, "public host websocket denied");
    return { ok: false, status: decision.status };
  }
  return { ok: true };
}
