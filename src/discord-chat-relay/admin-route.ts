/**
 * target ごとの中継トークンを設定画面から入力・差し替え・消去する管理 API
 * (spec/feature/discord-chat-relay.md §中継トークン、 DCR-INV-11)。
 *
 * 値は書き込むだけで読み返さない。 一覧は target ごとに「設定済みかどうか」 だけを返す。
 * LINE の管理 API (src/line-webhook/admin-route.ts) と同じ形。
 *
 * @implements spec/feature/discord-chat-relay.md — 中継トークン
 */

import { Hono } from "hono";
import {
  clearDiscordChatRelaySecret,
  describeDiscordChatRelaySecrets,
  isDiscordChatRelaySecretField,
  setDiscordChatRelaySecret,
  type DiscordChatRelaySecretStore,
} from "./secrets.js";
import type { DiscordChatRelayTarget } from "./targets.js";

/** これを超える値は貼り間違いとして弾く (LINE と同じ上限)。 */
const MAX_SECRET_LENGTH = 4096;

export interface DiscordChatRelayAdminDeps {
  targets: () => readonly DiscordChatRelayTarget[];
  store: DiscordChatRelaySecretStore;
}

export function discordChatRelayAdminRouter(deps: DiscordChatRelayAdminDeps): Hono {
  const app = new Hono();

  app.get("/targets", (c) => c.json({
    targets: deps.targets().map((target) => ({
      name: target.name,
      enabled: target.enabled,
      channel_ids: target.channelIds,
      ...describeDiscordChatRelaySecrets(deps.store, target.name),
    })),
  }));

  app.put("/targets/:target/secrets/:field", async (c) => {
    const located = locate(deps, c.req.param("target"), c.req.param("field"));
    if ("error" in located) return c.json({ error: located.error }, located.status);
    const body = await c.req.json().catch(() => null) as { value?: unknown } | null;
    const value = typeof body?.value === "string" ? body.value.trim() : "";
    if (value === "" || value.length > MAX_SECRET_LENGTH) {
      return c.json({ error: "invalid_value", detail: `1〜${MAX_SECRET_LENGTH} 文字で入力します` }, 400);
    }
    setDiscordChatRelaySecret(deps.store, located.target, located.field, value);
    return c.json({ ok: true, ...describeDiscordChatRelaySecrets(deps.store, located.target) });
  });

  app.delete("/targets/:target/secrets/:field", (c) => {
    const located = locate(deps, c.req.param("target"), c.req.param("field"));
    if ("error" in located) return c.json({ error: located.error }, located.status);
    clearDiscordChatRelaySecret(deps.store, located.target, located.field);
    return c.json({ ok: true, ...describeDiscordChatRelaySecrets(deps.store, located.target) });
  });

  return app;
}

/** 登録済みの target (enabled は問わない) と既知の項目だけを受け付ける。 */
function locate(deps: DiscordChatRelayAdminDeps, target: string, field: string) {
  if (!deps.targets().some((item) => item.name === target)) {
    return { error: "unknown_target", status: 404 as const };
  }
  if (!isDiscordChatRelaySecretField(field)) return { error: "unknown_field", status: 404 as const };
  return { target, field };
}
