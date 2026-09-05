import type { Hono } from "hono";
import { z } from "zod";
import type { AdminState } from "../admin/state.js";
import type { ChatRepo } from "../db/chat-repo.js";
import type { DayReportsRepo } from "../db/day-reports-repo.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import type { SlackConfigRepo } from "../db/slack-config-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { StaffRepo } from "../db/staff-repo.js";
import type { SchedulerHandle } from "../daily/scheduler.js";
import type { MetricsStore } from "../metrics/store.js";
import { setDiscordConfig, discordConfigStatus } from "../discord/conn-config.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import { createChildLogger } from "../shared/logger.js";
import { getReactionWorkflowReadiness } from "../shared/reaction-workflow-readiness.js";
import type { SecretBox } from "../shared/secret-box.js";
import { chatRouter } from "./chat.js";
import {
  reactionSkillWorkflowRouter,
  reactionWorkflowMigrationRouter,
} from "./reaction-skill-workflows.js";
import { SkillCatalogStore } from "../skills/catalog-store.js";
import { migrateBuiltinWorkflowsToSkills } from "../platform/reaction-workflow.js";
import { dailyRouter } from "./daily.js";
import { monitorRouter } from "./monitor.js";
import type { BotRuntimeStatus } from "./platform-runtime-status.js";
import { slackAdminRouter, type SlackBotAdmin } from "./slack-admin.js";
import { workflowGate } from "../workflow/api-gate.js";

const reactionWorkflowLog = createChildLogger("reaction-workflow-config");
// 発火ユーザの allowlist はここには無い。 誰が発火できるかは社員名簿 (/v1/staff) の
// 役職で決まる (spec/feature/staff-roster.md §4)。 このエンドポイントは ON/OFF だけ。
const ReactionWorkflowUpdateSchema = z.object({
  enabled: z.boolean(),
}).strict();

export interface DiscordBotAdmin {
  start: () => Promise<{ ok: boolean; status: "started" | "already_running" | "disabled" | "error"; error?: string }>;
  stop: () => Promise<{ ok: boolean; status: "stopped" | "already_stopped" | "error"; error?: string }>;
  restart: () => Promise<{ ok: boolean; status: "restarted" | "started" | "disabled" | "error"; error?: string }>;
  status: () => BotRuntimeStatus;
}

export interface ChatDeps {
  repo: SessionsRepo;
  metrics?: MetricsStore;
  chat: ChatRepo;
  dayReports: DayReportsRepo;
  dailyScheduler: SchedulerHandle;
  adminState: AdminState;
  discordConfig: DiscordConfigRepo;
  discordAdmin?: DiscordBotAdmin;
  slackConfig?: SlackConfigRepo;
  slackAdmin?: SlackBotAdmin;
  secretBox?: SecretBox;
  /** 社員名簿。 リアクションワークフローの「発火できる人が居るか」判定に使う。 */
  staff?: StaffRepo;
  /**
   * スキルカタログ (`.claude/skills` / `.claude/commands`)。 RWF の「スキル割り当て」
   * 設定画面と移行 API が使う。 未注入ならワークスペースルートから自前で作る。
   */
  skillCatalog?: SkillCatalogStore;
}

export function registerChatRoutes(app: Hono, deps: ChatDeps): void {
  // workflow.daily が無効なら日次レビュー API は 409 + 理由 (無言の 404 にしない)。
  {
    const gate = workflowGate("daily", () => deps.adminState.isWorkflowEnabled("daily"));
    app.use("/v1/daily-reports", gate);
    app.use("/v1/daily-reports/*", gate);
  }
  // ReactionWorkflow 固有の設定 API も、 workflow.reaction が無効なら利用させない。
  // 有効化そのものは /v1/admin/workflows から行えるため、再有効化の経路は残る。
  {
    const gate = workflowGate("reaction", () => deps.adminState.isWorkflowEnabled("reaction"));
    for (const prefix of [
      "/v1/admin/reaction-workflow",
      "/v1/admin/reaction-mappings",
      "/v1/admin/reaction-action-policies",
      "/v1/admin/reaction-skill-workflows",
      "/v1/reaction-workflow",
    ]) {
      app.use(prefix, gate);
      app.use(`${prefix}/*`, gate);
    }
  }
  // RWF の「絵文字 → スキル」割り当て (設計 §10.2 C-10) と、 組み込み → スキルの移行
  // (§11.2 の 2)。 保存先は Runner と同じ customWorkflows JSON。
  const skillCatalog = deps.skillCatalog
    ?? new SkillCatalogStore(() => deps.adminState.getWorkspaceRoot());
  const skillWorkflowDeps = {
    resolveWorkspaceRoot: () => deps.adminState.getWorkspaceRoot(),
    catalog: skillCatalog,
    migrateBuiltin: async () => migrateBuiltinWorkflowsToSkills({
      workspaceRoot: deps.adminState.getWorkspaceRoot(),
      catalog: (await skillCatalog.ensure()).entries,
    }),
  };
  app.route("/v1/admin/reaction-skill-workflows", reactionSkillWorkflowRouter(skillWorkflowDeps));
  app.route("/v1/reaction-workflow", reactionWorkflowMigrationRouter(skillWorkflowDeps));

  app.route("/v1/monitor", monitorRouter({
    repo: deps.repo,
    metrics: deps.metrics,
    resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots(),
  }));
  app.route("/v1/chat", chatRouter({
    chat: deps.chat,
    resolveWorkspaceRoots: () => deps.adminState.getWorkspaceRoots(),
  }));
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

  const reactionWorkflowStatus = () => {
    const enabled = deps.adminState.getReactionWorkflowEnabled();
    return {
      enabled,
      readiness: getReactionWorkflowReadiness({
        enabled,
        discordAuthorizedCount: deps.staff?.countByCapability("discord", "session_spawn") ?? 0,
        slackAuthorizedCount: deps.staff?.countByCapability("slack", "session_spawn") ?? 0,
      }),
    };
  };

  app.get("/v1/admin/reaction-workflow", (c) => c.json(reactionWorkflowStatus()));
  app.put("/v1/admin/reaction-workflow", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ReactionWorkflowUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    deps.adminState.setReactionWorkflowEnabled(parsed.data.enabled);

    const status = reactionWorkflowStatus();
    if (status.readiness.issues.length > 0) {
      reactionWorkflowLog.warn(
        {
          readiness: status.readiness.status,
          issues: status.readiness.issues,
          discord_user_count: status.readiness.platforms.discord.authorized_user_count,
          slack_user_count: status.readiness.platforms.slack.authorized_user_count,
        },
        "reaction-workflow is enabled but no staff member holds the firing capability",
      );
    }
    return c.json(status);
  });

  app.get("/v1/admin/cc-workflow", (c) => {
    return c.json({ enabled: deps.adminState.getCcWorkflowEnabled() });
  });
  app.put("/v1/admin/cc-workflow", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.enabled !== "boolean") {
      return c.json({ error: "body.enabled (boolean) required" }, 400);
    }
    deps.adminState.setCcWorkflowEnabled(body.enabled);
    return c.json({ enabled: deps.adminState.getCcWorkflowEnabled() });
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
    const rwf = getRwf();
    if (rwf.isReservedNonActionEmoji(emoji)) {
      return c.json({ error: "body.emoji is reserved as non-actionable" }, 400);
    }
    if (!rwf.isWorkflowAction(action)) {
      return c.json({ error: `body.action must be one of ${rwf.WORKFLOW_ACTIONS.join(", ")}` }, 400);
    }
    deps.adminState.setReactionEmojiOverride(emoji, action);
    return c.json({ overrides: deps.adminState.getReactionEmojiOverrides() });
  });
  app.delete("/v1/admin/reaction-mappings/:emoji", (c) => {
    deps.adminState.deleteReactionEmojiOverride(decodeURIComponent(c.req.param("emoji")));
    return c.json({ overrides: deps.adminState.getReactionEmojiOverrides() });
  });

  // アクション別ポリシー (子会社可否 / 要求権限)。 2026-09-02 neco 指示。
  app.get("/v1/admin/reaction-action-policies", (c) => {
    const rwf = getRwf();
    const overrides = deps.adminState.getReactionActionPolicies();
    return c.json({
      actions: rwf.WORKFLOW_ACTIONS.map((action) => ({
        action,
        help: rwf.WORKFLOW_ACTION_HELP[action] ?? null,
        defaults: rwf.workflowActionDefaults(action),
        override: overrides[action] ?? null,
      })),
      capabilities: rwf.WORKFLOW_ACTION_POLICY_CAPABILITIES,
    });
  });
  app.put("/v1/admin/reaction-action-policies", async (c) => {
    const body = await c.req.json().catch(() => null) as {
      action?: unknown; subsidiary?: unknown; capability?: unknown;
    } | null;
    const rwf = getRwf();
    const action = typeof body?.action === "string" ? body.action : "";
    if (!rwf.isWorkflowAction(action)) {
      return c.json({ error: `body.action must be one of ${rwf.WORKFLOW_ACTIONS.join(", ")}` }, 400);
    }
    const patch: { subsidiary?: boolean | null; capability?: string | null } = {};
    if (body?.subsidiary !== undefined) {
      if (body.subsidiary !== null && typeof body.subsidiary !== "boolean") {
        return c.json({ error: "body.subsidiary must be boolean or null" }, 400);
      }
      patch.subsidiary = body.subsidiary as boolean | null;
    }
    if (body?.capability !== undefined) {
      const valid = body.capability === null || body.capability === "none"
        || (typeof body.capability === "string"
          && (rwf.WORKFLOW_ACTION_POLICY_CAPABILITIES as readonly string[]).includes(body.capability));
      if (!valid) {
        return c.json({ error: "body.capability must be none/session_spawn/merge_pr/kill_switch/session_end or null" }, 400);
      }
      patch.capability = body.capability as string | null;
    }
    deps.adminState.setReactionActionPolicy(action, patch);
    return c.json({ overrides: deps.adminState.getReactionActionPolicies() });
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

    const statusPayload = () => ({
      ...discordConfigStatus(deps.discordConfig!, deps.secretBox!),
      runtime: deps.discordAdmin!.status(),
    });

    app.get("/v1/admin/discord/config", (c) =>
      c.json(statusPayload()),
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
        status: statusPayload(),
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
