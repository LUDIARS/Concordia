/**
 * /v1/admin/slack — Slack 連携をサービス内 (Web UI / API) から設定する.
 *
 * - GET  /config  : redact 済み設定状態 (token 値は返さない)
 * - PUT  /config  : 設定更新 (token は暗号化保存) → bot を hot 再接続 (設定時点で有効)
 * - POST /start /stop /restart : bot ライフサイクル制御 (discord と同形)
 * - GET/PUT /member-map : 起動者招待用の Discord ID → Slack ID 対応表 (再接続しない)
 * - GET/PUT /always-invite : 全 session channel に招待する Slack ユーザ ID 一覧 (再接続しない)
 *
 * Discord の /v1/admin/discord/{start,stop,restart} と対の構成。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SlackConfigRepo } from "../db/slack-config-repo.js";
import type { SecretBox } from "../shared/secret-box.js";
import { getSlackAlwaysInvite, getSlackMemberMap, setSlackAlwaysInvite, setSlackConfig, setSlackMemberMap, slackConfigStatus } from "../slack/config.js";
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

const MemberMapSchema = z.object({
  entries: z.array(z.object({
    discord_user_id: z.string().max(64),
    slack_user_id: z.string().max(64),
  }).strict()).max(500),
}).strict();

const AlwaysInviteSchema = z.object({
  user_ids: z.array(z.string().max(64)).max(50),
}).strict();

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

  // メンバー対応表は招待のたびに読まれるので、 保存しても bot は再接続しない。
  app.get("/member-map", (c) => c.json({ entries: getSlackMemberMap(deps.config, deps.secretBox) }));

  app.put("/member-map", async (c) => {
    const parsed = MemberMapSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      return c.json({ entries: setSlackMemberMap(deps.config, deps.secretBox, parsed.data.entries) });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  // 常時招待メンバーも招待のたびに読まれるので、 保存しても bot は再接続しない。
  app.get("/always-invite", (c) => c.json({ user_ids: getSlackAlwaysInvite(deps.config, deps.secretBox) }));

  app.put("/always-invite", async (c) => {
    const parsed = AlwaysInviteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      return c.json({ user_ids: setSlackAlwaysInvite(deps.config, deps.secretBox, parsed.data.user_ids) });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
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
