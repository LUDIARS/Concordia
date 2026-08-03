/**
 * /v1/admin/revisor — Revisor 連携 (workflow token) をサービス内 (Web UI / API) から設定する。
 *
 * - GET /config : redact 済み状態 (token 値は返さない)
 * - PUT /config : token を暗号化保存 / 空文字で env フォールバックへ戻す
 *
 * @implements spec/feature/revisor-local-pr-submission.md — 6. token
 *
 * Discord の /v1/admin/discord, Slack の /v1/admin/slack と対の構成。
 * 保存した値は次のリクエストから効く (クライアントが token を都度解決するため、再起動不要)。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { RevisorConfigRepo } from "../db/revisor-config-repo.js";
import type { SecretBox } from "../shared/secret-box.js";
import { revisorConfigStatus, setRevisorConfig } from "../pr/revisor-config.js";

export interface RevisorAdminDeps {
  config: RevisorConfigRepo;
  secretBox: SecretBox;
}

const PutSchema = z.object({
  // null / 空文字 = クリア (env フォールバックに戻す)、 文字列 = 設定
  workflow_token: z.string().max(512).nullable().optional(),
});

export function revisorAdminRouter(deps: RevisorAdminDeps): Hono {
  const app = new Hono();

  app.get("/config", (c) => c.json(revisorConfigStatus(deps.config, deps.secretBox)));

  app.put("/config", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PutSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    setRevisorConfig(deps.config, deps.secretBox, { workflowToken: parsed.data.workflow_token });
    return c.json(revisorConfigStatus(deps.config, deps.secretBox));
  });

  return app;
}
