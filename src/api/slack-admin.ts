/**
 * /v1/admin/slack — Slack 連携をサービス内 (Web UI / API) から設定する.
 *
 * - GET  /config  : redact 済み設定状態 (token 値は返さない)
 * - PUT  /config  : 設定更新 (token は暗号化保存) → bot を hot 再接続 (設定時点で有効)
 * - POST /start /stop /restart : bot ライフサイクル制御 (discord と同形)
 *
 * Discord の /v1/admin/discord/{start,stop,restart} と対の構成。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SlackConfigRepo } from "../db/slack-config-repo.js";
import type { SecretBox } from "../shared/secret-box.js";
import { setSlackConfig, slackConfigStatus } from "../slack/config.js";
import type { BotRuntimeStatus } from "./platform-runtime-status.js";

export interface SlackBotAdmin {
  start: () => Promise<{ ok: boolean; status: string; error?: string }>;
  stop: () => Promise<{ ok: boolean; status: string; error?: string }>;
  restart: () => Promise<{ ok: boolean; status: string; error?: string }>;
  status: () => BotRuntimeStatus;
}

export interface SlackAdminDeps {
  config: SlackConfigRepo;
  secretBox: SecretBox;
  admin: SlackBotAdmin;
}

const PutSchema = z.object({
  enabled: z.boolean().optional(),
  // null / 空文字 = クリア (env フォールバックに戻す)、 文字列 = 設定
  channel_id: z.string().max(64).nullable().optional(),
  bot_token: z.string().max(256).nullable().optional(),
  app_token: z.string().max(256).nullable().optional(),
});

export function slackAdminRouter(deps: SlackAdminDeps): Hono {
  const app = new Hono();

  const statusPayload = () => ({
    ...slackConfigStatus(deps.config, deps.secretBox),
    runtime: deps.admin.status(),
  });

  app.get("/config", (c) => c.json(statusPayload()));

  // 設定保存 → そのまま hot 再接続して「設定時点で有効」にする。
  app.put("/config", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = PutSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    setSlackConfig(deps.config, deps.secretBox, {
      enabled: parsed.data.enabled,
      channelId: parsed.data.channel_id,
      botToken: parsed.data.bot_token,
      appToken: parsed.data.app_token,
    });
    const restart = await deps.admin.restart();
    return c.json({
      ok: restart.ok,
      status: statusPayload(),
      restart,
    });
  });

  app.post("/start", async (c) => {
    const r = await deps.admin.start();
    return c.json(r, r.ok ? 200 : 500);
  });
  app.post("/stop", async (c) => {
    const r = await deps.admin.stop();
    return c.json(r, r.ok ? 200 : 500);
  });
  app.post("/restart", async (c) => {
    const r = await deps.admin.restart();
    return c.json(r, r.ok ? 200 : 500);
  });

  return app;
}
