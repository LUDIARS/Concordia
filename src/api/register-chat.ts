import type { Hono } from "hono";
import { z } from "zod";
import type { AdminState } from "../admin/state.js";
import type { ChatRepo } from "../db/chat-repo.js";
import type { DayReportsRepo } from "../db/day-reports-repo.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import type { SlackConfigRepo } from "../db/slack-config-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { Dispatcher } from "../dispatcher.js";
import type { SchedulerHandle } from "../daily/scheduler.js";
import type { MetricsStore } from "../metrics/store.js";
import { setDiscordConfig, discordConfigStatus } from "../discord/conn-config.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import type { SecretBox } from "../shared/secret-box.js";
import { chatRouter } from "./chat.js";
import { dailyRouter } from "./daily.js";
import { monitorRouter } from "./monitor.js";
import { slackAdminRouter, type SlackBotAdmin } from "./slack-admin.js";
import { streamRouter } from "./stream.js";

export interface DiscordBotAdmin {
  start: () => Promise<{ ok: boolean; status: "started" | "already_running" | "disabled" | "error"; error?: string }>;
  stop: () => Promise<{ ok: boolean; status: "stopped" | "already_stopped" | "error"; error?: string }>;
  restart: () => Promise<{ ok: boolean; status: "restarted" | "started" | "disabled" | "error"; error?: string }>;
}

export interface ChatDeps {
  repo: SessionsRepo;
  metrics?: MetricsStore;
  chat: ChatRepo;
  dispatcher: Dispatcher;
  dayReports: DayReportsRepo;
  dailyScheduler: SchedulerHandle;
  adminState: AdminState;
  discordConfig: DiscordConfigRepo;
  discordAdmin?: DiscordBotAdmin;
  slackConfig?: SlackConfigRepo;
  slackAdmin?: SlackBotAdmin;
  secretBox?: SecretBox;
}

export function registerChatRoutes(app: Hono, deps: ChatDeps): void {
  app.route("/v1/monitor", monitorRouter({ repo: deps.repo, metrics: deps.metrics }));
  app.route("/v1/chat", chatRouter({ chat: deps.chat, dispatcher: deps.dispatcher }));
  app.route("/v1/stream", streamRouter());
  app.route(
    "/v1/daily-reports",
    dailyRouter({ dayReports: deps.dayReports, scheduler: deps.dailyScheduler }),
  );

  app.get("/v1/admin/chat-mute", (c) => {
    return c.json({ muted: deps.adminState.getChatMuted() });
  });
  app.put("/v1/admin/chat-mute", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.muted !== "boolean") {
      return c.json({ error: "body.muted (boolean) required" }, 400);
    }
    deps.adminState.setChatMuted(body.muted);
    return c.json({ muted: deps.adminState.getChatMuted() });
  });

  app.get("/v1/admin/reaction-workflow", (c) => {
    return c.json({ enabled: deps.adminState.getReactionWorkflowEnabled() });
  });
  app.put("/v1/admin/reaction-workflow", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: "body.enabled (boolean) required" }, 400);
    }
    deps.adminState.setReactionWorkflowEnabled(body.enabled);
    return c.json({ enabled: deps.adminState.getReactionWorkflowEnabled() });
  });

  app.get("/v1/admin/reaction-mappings", (c) => {
    const rwf = getRwf();
    const defaults = rwf.defaultReactionEmojiMap();
    const overrides = deps.adminState.getReactionEmojiOverrides();
    return c.json({ defaults, overrides, actions: rwf.WORKFLOW_ACTIONS, action_help: rwf.WORKFLOW_ACTION_HELP });
  });
  app.put("/v1/admin/reaction-mappings", async (c) => {
    const body = await c.req.json().catch(() => null);
    const emoji = typeof body?.emoji === "string" ? body.emoji.trim() : "";
    const action = typeof body?.action === "string" ? body.action : "";
    if (!emoji) return c.json({ error: "body.emoji (string) required" }, 400);
    if (!getRwf().isWorkflowAction(action)) {
      return c.json({ error: `body.action must be one of ${getRwf().WORKFLOW_ACTIONS.join(", ")}` }, 400);
    }
    deps.adminState.setReactionEmojiOverride(emoji, action);
    return c.json({ overrides: deps.adminState.getReactionEmojiOverrides() });
  });
  app.delete("/v1/admin/reaction-mappings/:emoji", (c) => {
    deps.adminState.deleteReactionEmojiOverride(decodeURIComponent(c.req.param("emoji")));
    return c.json({ overrides: deps.adminState.getReactionEmojiOverrides() });
  });

  app.post("/v1/admin/discord/start", async (c) => {
    if (!deps.discordAdmin) return c.json({ ok: false, error: "discord_admin_not_ready" }, 503);
    const r = await deps.discordAdmin.start();
    return c.json(r, r.ok ? 200 : 500);
  });
  app.post("/v1/admin/discord/stop", async (c) => {
    if (!deps.discordAdmin) return c.json({ ok: false, error: "discord_admin_not_ready" }, 503);
    const r = await deps.discordAdmin.stop();
    return c.json(r, r.ok ? 200 : 500);
  });
  app.post("/v1/admin/discord/restart", async (c) => {
    if (!deps.discordAdmin) return c.json({ ok: false, error: "discord_admin_not_ready" }, 503);
    const r = await deps.discordAdmin.restart();
    return c.json(r, r.ok ? 200 : 500);
  });

  if (deps.discordConfig && deps.secretBox && deps.discordAdmin) {
    const DiscordPutSchema = z.object({
      enabled: z.boolean().optional(),
      guild_id: z.string().max(64).nullable().optional(),
      application_id: z.string().max(64).nullable().optional(),
      token: z.string().max(256).nullable().optional(),
      permission_requests_enabled: z.boolean().optional(),
      message_optimization_enabled: z.boolean().optional(),
    });

    app.get("/v1/admin/discord/config", (c) =>
      c.json(discordConfigStatus(deps.discordConfig!, deps.secretBox!)),
    );

    app.put("/v1/admin/discord/config", async (c) => {
      const body = await c.req.json().catch(() => null);
      const parsed = DiscordPutSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
      setDiscordConfig(deps.discordConfig!, deps.secretBox!, {
        enabled: parsed.data.enabled,
        guildId: parsed.data.guild_id,
        applicationId: parsed.data.application_id,
        token: parsed.data.token,
        permissionRequestsEnabled: parsed.data.permission_requests_enabled,
        messageOptimizationEnabled: parsed.data.message_optimization_enabled,
      });
      const restart = await deps.discordAdmin!.restart();
      return c.json({
        ok: restart.ok,
        status: discordConfigStatus(deps.discordConfig!, deps.secretBox!),
        restart,
      });
    });
  }

  if (deps.slackConfig && deps.secretBox && deps.slackAdmin) {
    app.route(
      "/v1/admin/slack",
      slackAdminRouter({ config: deps.slackConfig, secretBox: deps.secretBox, admin: deps.slackAdmin }),
    );
  }
}
