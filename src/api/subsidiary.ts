/**
 * /v1/subsidiaries API。 子会社 CRUD + 許可 delegation + ロック + Bot ライフサイクル
 * + 監査ログ。 loopback 信頼境界 (token 不要、 他 /v1/admin/* と同様)。
 *
 * token (bot/app) は secret-box で暗号化して保存し、 GET では値を返さず set 済みかだけ。
 * spec/feature/subsidiary-delegation.md §5。
 */

import { Hono } from "hono";
import { z } from "zod";
import type { SubsidiaryDelegationRow, SubsidiaryRepo, SubsidiaryRow } from "../db/subsidiary-repo.js";
import type { DelegationRepo } from "../db/delegation-repo.js";
import type { SubsidiaryBotManager } from "../subsidiary/manager.js";
import type { SubsidiaryBudgetTracker } from "../subsidiary/budget.js";
import type { SecretBox } from "../shared/secret-box.js";
import { ownedToPortable, parsePortable, templateToPortable } from "../delegation/portable.js";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import { NAME_RE, resolveSubsidiaryName } from "../subsidiary/name-slug.js";
import type { TeamRow, TeamsRepo } from "../db/teams-repo.js";
import {
  DiscordChannelGuildMismatchError,
  type SubsidiaryDiscordReader,
} from "../subsidiary/discord-read.js";

const CreateSchema = z.object({
  // 入力は弾かず受け取り、 正規 slug でなければ自動正規化する (resolveSubsidiaryName)。
  // 受付チャンネル名の自動補正と同じ発想。 空だけは拒否 (補正の手掛かりが無い)。
  name: z.string().min(1).max(120),
  display_name: z.string().max(120).optional(),
  description: z.string().max(2000).optional(),
  platform: z.enum(["discord", "slack"]).optional(),
  // subsidiary = 別サーバへ出張する子会社 (専用 Bot を起動) / desk = 本社サーバ内の
  // 軽量窓口 (Bot を起動せず、 本社 Bot が「タスク依頼」チャンネルを受け付ける)。
  mode: z.enum(["subsidiary", "desk"]).optional(),
  enabled: z.boolean().optional(),
  guild_id: z.string().max(64).nullable().optional(),
  application_id: z.string().max(64).nullable().optional(),
  channel_id: z.string().max(64).nullable().optional(),
  bot_token: z.string().max(200).nullable().optional(),
  app_token: z.string().max(200).nullable().optional(),
  guard_model: z.string().max(64).optional(),
  guard_scope: z.string().max(8000).optional(),
  daily_token_budget: z.number().int().min(0).max(1_000_000_000).optional(),
  default_team_id: z.string().trim().min(1).max(120).nullable().optional(),
  // 関係 project (project_codes.project と同じ表記)。 Test forum の掲載範囲を決める。
  // 省略 = 据え置き / [] = 未設定 (1 件も載せない)。 spec §3.4。
  projects: z.array(z.string().trim().min(1).max(120)).max(200).optional(),
});

const PatchSchema = CreateSchema.partial().omit({ name: true });

const CALL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;

/** 所有 delegation の clone 元 (グローバルテンプレ) を call_name で指定する。 */
const CloneDelegationSchema = z.object({
  call_name: z.string().regex(CALL_NAME_RE),
  /** clone 先の call_name を変えたい場合 (省略時は元と同じ)。 */
  as_call_name: z.string().regex(CALL_NAME_RE).optional(),
  is_default: z.boolean().optional(),
});

const LockSchema = z.object({
  platform: z.enum(["discord", "slack"]),
  platform_user_id: z.string().max(64),
  user_label: z.string().max(120).optional(),
  reason: z.string().max(2000).optional(),
});

export interface SubsidiaryApiDeps {
  repo: SubsidiaryRepo;
  /** グローバル delegation テンプレ (所有 delegation の clone 元)。 */
  delegationRepo: DelegationRepo;
  manager: SubsidiaryBotManager;
  secretBox: SecretBox;
  /** 子会社の日次トークン予算トラッカー (当日消費を serialize に載せる)。 省略可。 */
  budget?: SubsidiaryBudgetTracker;
  /** name 自動正規化で日本語等をローマ字 slug 化する Haiku (claude CLI)。 省略時は決定的経路のみ。 */
  runClaude?: RunClaudeFn;
  /** 自動正規化の fallback を記録する logger。 省略可。 */
  log?: { warn: (msg: string) => void };
  /** 子会社チーム一覧と default_team_id の所有権検証。 */
  teams?: TeamsRepo;
  /** 子会社 Discord の読み取り (REST)。 未注入なら /discord/* は 503。 */
  discordRead?: SubsidiaryDiscordReader;
}

/** 所有 delegation 行を API 表現へ (input_schema を配列にパース)。 */
function serializeOwnedDelegation(row: SubsidiaryDelegationRow) {
  return {
    call_name: row.call_name,
    is_default: row.is_default === 1,
    title: row.title,
    description: row.description,
    target_provider: row.target_provider,
    model: row.model,
    prompt_template: row.prompt_template,
    input_schema: safeJsonParse(row.input_schema, [] as unknown[]),
    default_cwd: row.default_cwd,
    project: row.project,
    emoji: row.emoji,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function safeJsonParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function serializeSubsidiaryTeam(repo: TeamsRepo, row: TeamRow) {
  return {
    ...row,
    settings: safeJsonParse(row.settings_json, {} as Record<string, unknown>),
    repos: repo.repos(row.id),
    suspended: row.suspended_at !== null,
  };
}

export function subsidiaryRouter(deps: SubsidiaryApiDeps): Hono {
  const app = new Hono();

  /** token を伏せて返す (set 済みかだけ)。 当日のコスト消費 / 予算 / block も載せる。 */
  async function serialize(row: SubsidiaryRow) {
    const { bot_token_enc, app_token_enc, ...rest } = row;
    const usage = await deps.budget?.status(row);
    return {
      ...rest,
      projects: deps.repo.listProjects(row.id),
      enabled: row.enabled === 1,
      bot_token_set: !!bot_token_enc,
      app_token_set: !!app_token_enc,
      running: deps.manager.isRunning(row.id),
      usage_today_tokens: usage?.todayTokens ?? 0,
      budget_blocked: usage?.blocked ?? false,
    };
  }

  /** undefined=据え置き / ""or null=クリア / 値=暗号化保存。 enc 値 (string|null|undefined) を返す。 */
  function encField(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    const v = (value ?? "").trim();
    return v ? deps.secretBox.encrypt(v) : null;
  }

  app.get("/", async (c) => {
    // Monitor の子会社カードが「直近 24h でガードが何件 allow/deny したか」を出すための集計。
    const since24h = Date.now() - 24 * 60 * 60 * 1000;
    const rows = await Promise.all(deps.repo.list().map(async (r) => ({
      ...(await serialize(r)),
      delegations: deps.repo.listDelegations(r.id).map(serializeOwnedDelegation),
      lock_count: deps.repo.listLocks(r.id).length,
      requests_24h: deps.repo.countRequestsSince(r.id, since24h),
    })));
    return c.json({ subsidiaries: rows });
  });

  app.get("/:id", async (c) => {
    const row = deps.repo.find(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    const teams = deps.teams;
    return c.json({
      subsidiary: await serialize(row),
      delegations: deps.repo.listDelegations(row.id).map(serializeOwnedDelegation),
      locks: deps.repo.listLocks(row.id),
      requests: deps.repo.recentRequests(row.id, 50),
      teams: teams?.listForSubsidiary(row.id).map((team) => serializeSubsidiaryTeam(teams, team)) ?? [],
    });
  });

  // ── 子会社 Discord の読み取り (2026-09-01 neco 指示) ──────────────────────
  // 調査・作業把握・ディレクターワークフロー用。 チーム所有の有無と無関係に guild_id が
  // あれば使える。 loopback 信頼境界なので本社のセッション / delegation からも叩ける
  // (= 本社側からの指示で子会社 Discord を読む経路)。 読み取り専用で書き込み口は無い。
  app.get("/:id/discord/channels", async (c) => {
    const row = deps.repo.find(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    if (!deps.discordRead) return c.json({ error: "discord_read_unavailable" }, 503);
    if (!row.guild_id) return c.json({ error: "guild_id_not_set" }, 400);
    if (!DISCORD_SNOWFLAKE_RE.test(row.guild_id)) return c.json({ error: "invalid_guild_id" }, 400);
    try {
      return c.json({ channels: await deps.discordRead.listChannels(row.guild_id) });
    } catch {
      deps.log?.warn(`subsidiary Discord channel listing failed subsidiary=${row.id}`);
      return c.json({ error: "discord_api_error" }, 502);
    }
  });

  app.get("/:id/discord/channels/:channelId/messages", async (c) => {
    const row = deps.repo.find(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    if (!deps.discordRead) return c.json({ error: "discord_read_unavailable" }, 503);
    if (!row.guild_id) return c.json({ error: "guild_id_not_set" }, 400);
    const channelId = c.req.param("channelId");
    const before = c.req.query("before")?.trim() || undefined;
    if (
      !DISCORD_SNOWFLAKE_RE.test(row.guild_id)
      || !DISCORD_SNOWFLAKE_RE.test(channelId)
      || (before !== undefined && !DISCORD_SNOWFLAKE_RE.test(before))
    ) {
      return c.json({ error: "invalid_discord_id" }, 400);
    }
    const limitRaw = Number(c.req.query("limit") ?? "50");
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 50;
    try {
      const messages = await deps.discordRead.readMessages(row.guild_id, channelId, { limit, before });
      return c.json({ messages });
    } catch (e) {
      // guild 不一致はクロス guild 読み出しの拒否 (403)。 それ以外は上流 API 失敗 (502)。
      if (e instanceof DiscordChannelGuildMismatchError) {
        return c.json({ error: "channel_not_in_subsidiary_guild" }, 403);
      }
      deps.log?.warn(`subsidiary Discord message read failed subsidiary=${row.id}`);
      return c.json({ error: "discord_api_error" }, 502);
    }
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    if (parsed.data.default_team_id) {
      // 新規子会社はまだチームを所有できない。作成 → チーム追加 → 既定設定の順にする。
      return c.json({ error: "default_team_must_be_assigned_after_create" }, 400);
    }
    // 入力 name が既に正規 slug かつ重複 → 明示 409 (利用者の意図が明確なので自動改名しない)。
    // 正規 slug でない場合は弾かず resolveSubsidiaryName が自動補正・自動一意化する。
    if (NAME_RE.test(parsed.data.name) && deps.repo.findByName(parsed.data.name)) {
      return c.json({ error: "name_taken" }, 409);
    }
    const resolved = await resolveSubsidiaryName(parsed.data.name, parsed.data.display_name, {
      exists: (n) => !!deps.repo.findByName(n),
      runClaude: deps.runClaude,
      log: deps.log,
    });
    const { bot_token, app_token, name: _rawName, projects, ...rest } = parsed.data;
    const row = deps.repo.create({
      ...rest,
      name: resolved.name,
      bot_token_enc: encField(bot_token) ?? null,
      app_token_enc: encField(app_token) ?? null,
    });
    if (projects !== undefined) deps.repo.setProjects(row.id, projects);
    return c.json(
      { subsidiary: await serialize(row), name_normalized: resolved.normalized, name_source: resolved.source },
      201,
    );
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    if (parsed.data.default_team_id) {
      const team = deps.teams?.find(parsed.data.default_team_id);
      if (!team || team.subsidiary_id !== id) {
        return c.json({ error: "default_team_not_owned_by_subsidiary" }, 400);
      }
    }
    const { bot_token, app_token, projects, ...rest } = parsed.data;
    // projects は「丸ごと置換」。 省略時は据え置き、 [] で未設定 (掲載ゼロ) に戻す。
    if (projects !== undefined) deps.repo.setProjects(id, projects);
    const row = deps.repo.update(id, {
      ...rest,
      bot_token_enc: encField(bot_token),
      app_token_enc: encField(app_token),
    });
    return c.json({ subsidiary: row ? await serialize(row) : null });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if ((deps.teams?.listForSubsidiary(id).length ?? 0) > 0) {
      return c.json({ error: "subsidiary_has_teams" }, 409);
    }
    await deps.manager.stop(id);
    const ok = deps.repo.delete(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });

  // ── 所有 delegation (子会社が複製所有する定義) ──────────────
  // 一覧は GET /:id に含む。 ここでは 1 件単位の upsert / 削除 / 既定設定 / clone / export。

  /** 可搬 JSON (貼付) で 1 件 upsert する。 call_name はパスで固定。 */
  app.put("/:id/delegations/:callName", async (c) => {
    const id = c.req.param("id");
    const callName = c.req.param("callName");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    if (!CALL_NAME_RE.test(callName)) return c.json({ error: "invalid_call_name" }, 400);
    const body = await c.req.json().catch(() => null);
    const parsed = parsePortable(body);
    if (!parsed.ok) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const p = parsed.data;
    // is_default は所有 delegation 固有の属性 (可搬 JSON には含めない)。 既定設定は
    // 専用エンドポイント (/default) で行う。 upsert では据え置き (新規は 0)。
    const row = deps.repo.upsertDelegation(id, {
      call_name: callName,
      title: p.title,
      description: p.description,
      target_provider: p.target_provider,
      model: p.model ?? null,
      prompt_template: p.prompt_template,
      input_schema: p.input_schema !== undefined ? JSON.stringify(p.input_schema) : undefined,
      default_cwd: p.default_cwd ?? null,
      project: p.project ?? null,
      emoji: p.emoji,
    });
    return c.json({ delegation: serializeOwnedDelegation(row) });
  });

  app.delete("/:id/delegations/:callName", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const ok = deps.repo.removeDelegation(id, c.req.param("callName"));
    return c.json({ ok });
  });

  /** 既定 delegation を 1 件立てる (他は 0 に落とす)。 */
  app.post("/:id/delegations/:callName/default", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const ok = deps.repo.setDefaultDelegation(id, c.req.param("callName"));
    if (!ok) return c.json({ error: "delegation_not_found" }, 404);
    return c.json({ ok: true, delegations: deps.repo.listDelegations(id).map(serializeOwnedDelegation) });
  });

  /** 所有 delegation を可搬 JSON で書き出す (コピー用)。 */
  app.get("/:id/delegations/:callName/export", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const row = deps.repo.findDelegation(id, c.req.param("callName"));
    if (!row) return c.json({ error: "delegation_not_found" }, 404);
    return c.json({ delegation: ownedToPortable(row) });
  });

  /** グローバルテンプレを所有 delegation に複製 (clone) する。 */
  app.post("/:id/delegations/clone", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = CloneDelegationSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const tpl = deps.delegationRepo.findTemplateByCallName(parsed.data.call_name);
    if (!tpl) return c.json({ error: "template_not_found" }, 404);
    const portable = templateToPortable(tpl);
    const row = deps.repo.upsertDelegation(id, {
      call_name: parsed.data.as_call_name ?? portable.call_name,
      is_default: parsed.data.is_default,
      title: portable.title,
      description: portable.description,
      target_provider: portable.target_provider,
      model: portable.model,
      prompt_template: portable.prompt_template,
      input_schema: JSON.stringify(portable.input_schema),
      default_cwd: portable.default_cwd,
      project: portable.project,
      emoji: portable.emoji,
    });
    return c.json({ delegation: serializeOwnedDelegation(row) }, 201);
  });

  // ── Bot lifecycle ─────────────────────────────────────────
  app.post("/:id/start", async (c) => c.json(await deps.manager.start(c.req.param("id"))));
  app.post("/:id/stop", async (c) => c.json(await deps.manager.stop(c.req.param("id"))));
  app.post("/:id/restart", async (c) => c.json(await deps.manager.restart(c.req.param("id"))));

  // ── requests (監査ログ) ───────────────────────────────────
  app.get("/:id/requests", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const limitRaw = Number(c.req.query("limit") ?? 100);
    const limit = Math.max(1, Math.min(500, isFinite(limitRaw) ? limitRaw : 100));
    return c.json({ requests: deps.repo.recentRequests(id, limit) });
  });

  // ── locks ─────────────────────────────────────────────────
  app.get("/:id/locks", (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    return c.json({ locks: deps.repo.listLocks(id) });
  });

  app.post("/:id/locks", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.find(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = LockSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    deps.repo.lock({ subsidiary_id: id, ...parsed.data });
    return c.json({ ok: true, locks: deps.repo.listLocks(id) });
  });

  app.delete("/:id/locks/:platform/:userId", (c) => {
    const id = c.req.param("id");
    const ok = deps.repo.unlock(id, c.req.param("platform"), c.req.param("userId"));
    return c.json({ ok });
  });

  return app;
}
