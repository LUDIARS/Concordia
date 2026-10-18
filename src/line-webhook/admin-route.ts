/**
 * target ごとの LINE チャネルの秘密値を設定画面から入力・差し替え・消去する管理 API
 * (spec/feature/line-webhook-relay.md §チャネルの秘密値)。
 *
 * 値は書き込むだけで読み返さない。 一覧は target ごとに「設定済みかどうか」 だけを返す。
 *
 * @implements spec/feature/line-webhook-relay.md — チャネルの秘密値
 */

import { Hono } from "hono";
import {
  clearLineChannelSecret,
  describeLineChannelSecrets,
  isLineChannelSecretField,
  setLineChannelSecret,
  type LineChannelSecretStore,
} from "./channel-secrets.js";
import type { LineWebhookTarget } from "./targets.js";

/** チャネルアクセストークン (長期) でも収まる長さ。 これを超える値は貼り間違いとして弾く。 */
const MAX_SECRET_LENGTH = 4096;

export interface LineWebhookAdminDeps {
  targets: () => readonly LineWebhookTarget[];
  store: LineChannelSecretStore;
}

export function lineWebhookAdminRouter(deps: LineWebhookAdminDeps): Hono {
  const app = new Hono();

  app.get("/targets", (c) => c.json({
    targets: deps.targets().map((target) => ({
      name: target.name,
      enabled: target.enabled,
      ...describeLineChannelSecrets(deps.store, target.name),
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
    setLineChannelSecret(deps.store, located.target, located.field, value);
    return c.json({ ok: true, ...describeLineChannelSecrets(deps.store, located.target) });
  });

  app.delete("/targets/:target/secrets/:field", (c) => {
    const located = locate(deps, c.req.param("target"), c.req.param("field"));
    if ("error" in located) return c.json({ error: located.error }, located.status);
    clearLineChannelSecret(deps.store, located.target, located.field);
    return c.json({ ok: true, ...describeLineChannelSecrets(deps.store, located.target) });
  });

  return app;
}

/** 登録済みの target (enabled は問わない) と既知の項目だけを受け付ける。 */
function locate(deps: LineWebhookAdminDeps, target: string, field: string) {
  if (!deps.targets().some((item) => item.name === target)) {
    return { error: "unknown_target", status: 404 as const };
  }
  if (!isLineChannelSecretField(field)) return { error: "unknown_field", status: 404 as const };
  return { target, field };
}
