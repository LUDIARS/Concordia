import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { TeamMetrics, TeamMetricsRepo } from "../db/team-metrics-repo.js";
import type { TeamRow, TeamsRepo } from "../db/teams-repo.js";
import { eventBus } from "../events.js";
import { TEAM_CARD_POST_KINDS } from "../shared/team-cards.js";

const PrRulesSchema = z.object({
  base: z.string().trim().min(1).max(200)
    .refine(isSafeGitBranchName, "invalid git branch name"),
  push: z.literal("revisor"),
}).strict();

const VibesDefaultsSchema = z.object({
  claim_sec: z.number().int().positive().max(86_400),
}).strict();

const SettingsSchema = z.object({
  revisor_lane: z.enum(["local", "github"]).optional(),
  pr_rules: PrRulesSchema.optional(),
  test_policy: z.enum(["confirm-queue", "custos-unity"]).optional(),
  worktree: z.enum(["allowed", "repo-root-only"]).optional(),
  visibility: z.enum(["public", "private"]).optional(),
  vibes_defaults: VibesDefaultsSchema.optional(),
}).strict();

const RepositoriesSchema = z.array(z.string().trim().min(1).max(500)).max(200)
  .refine((repos) => new Set(repos).size === repos.length, "duplicate repository");

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  repos: RepositoriesSchema.default([]),
  settings: SettingsSchema.default({}),
  rules_text: z.string().max(50_000).default(""),
});

const PatchSchema = CreateSchema.partial();

/**
 * チーム面へ載せる報告カード。 種別は面へのルーティング (team-card-routing.ts) に
 * 対応する固定集合に限る — 任意の面へ任意本文を投げられる口にはしない。
 */
const CardSchema = z.object({
  // 受付種別の正本は shared/team-cards.ts (spec/feature/director-workflow.md §3)。
  kind: z.enum(TEAM_CARD_POST_KINDS),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(20_000),
}).strict();

export type TeamSettings = z.infer<typeof SettingsSchema>;

/**
 * `pr_rules.base` is rendered into delegation instructions and may later be passed to Git.
 * Keep the accepted subset deliberately conservative so control characters, Markdown escapes,
 * and refname metacharacters cannot turn a typed setting into prompt or command syntax.
 */
function isSafeGitBranchName(value: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return false;
  if (value === "@" || value.includes("..") || value.includes("//") || value.includes("@{")) return false;
  return value.split("/").every((segment) =>
    segment.length > 0 && !segment.startsWith(".") && !segment.endsWith(".") && !segment.endsWith(".lock"));
}

/** teams.settings_json を typed TeamSettings へ解決する。下流の消費経路の共通入口。 */
export function parseTeamSettings(row: TeamRow): TeamSettings {
  return SettingsSchema.parse(JSON.parse(row.settings_json) as unknown);
}

export function teamsRouter(repo: TeamsRepo, metrics?: TeamMetricsRepo): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const byTeam = metrics?.collect() ?? null;
    return c.json({
      teams: repo.list().map((team) => ({
        ...serializeTeam(repo, team),
        ...(byTeam ? { metrics: byTeam.get(team.id) ?? EMPTY_METRICS } : {}),
      })),
    });
  });

  // チーム詳細タブのコストグラフ用時系列 (cost_usage_samples の read model)。
  app.get("/:id/cost", (c) => {
    if (!metrics) return c.json({ error: "metrics_unavailable" }, 503);
    const team = repo.find(c.req.param("id"));
    if (!team) return c.json({ error: "not_found" }, 404);
    const nowSec = Math.floor(Date.now() / 1000);
    const since = readPositiveInt(c.req.query("since")) ?? nowSec - 7 * 86_400;
    const bucket = readPositiveInt(c.req.query("bucket")) ?? 3600;
    return c.json({
      team_id: team.id,
      bucketSec: bucket,
      points: metrics.costSeries(team.id, since, bucket),
    });
  });

  // Concordia binds to loopback and this route shares the existing admin UI trust boundary.
  app.post("/", async (c) => {
    const parsed = CreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_team", detail: parsed.error.flatten() }, 400);
    const row = repo.create(parsed.data);
    repo.setRepos(row.id, parsed.data.repos);
    eventBus.emit({
      type: "team.created",
      event_id: randomUUID(),
      team_id: row.id,
      name: row.name,
      slug: row.slug,
      ts: Math.floor(Date.now() / 1000),
    });
    return c.json({ team: serializeTeam(repo, row) }, 201);
  });

  app.patch("/:id", async (c) => {
    const parsed = PatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_team", detail: parsed.error.flatten() }, 400);
    const row = repo.patch(c.req.param("id"), parsed.data);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (parsed.data.repos) repo.setRepos(row.id, parsed.data.repos);
    eventBus.emit({
      type: "team.changed",
      event_id: randomUUID(),
      team_id: row.id,
      fields: Object.keys(parsed.data),
      ts: Math.floor(Date.now() / 1000),
    });
    return c.json({ team: serializeTeam(repo, row) });
  });

  /**
   * 一時停止 / 再開 (2026-08-27 neco 指示: 作業していないチームは一時的に止められる)。
   *
   * 一時停止中のチームは定時 fanout (朝礼 / 定例 / issue scout / タスク整理) の対象から
   * 外れる。 アーカイブではないので、 手動 spawn・チーム面・設定はそのまま生きる。
   * 冪等 — 既に同じ状態なら 200 でそのまま返す。
   */
  const setSuspended = (idOrSlug: string, suspended: boolean): { team: TeamRow } | null => {
    const team = repo.findByIdOrSlug(idOrSlug);
    if (!team) return null;
    const changed = (team.suspended_at !== null) !== suspended;
    const row = repo.setSuspended(team.id, suspended)!;
    if (changed) {
      eventBus.emit({
        type: "team.changed",
        event_id: randomUUID(),
        team_id: row.id,
        fields: ["suspended_at"],
        ts: Math.floor(Date.now() / 1000),
      });
    }
    return { team: row };
  };
  app.post("/:id/suspend", (c) => {
    const result = setSuspended(c.req.param("id"), true);
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json({ team: serializeTeam(repo, result.team) });
  });
  app.post("/:id/resume", (c) => {
    const result = setSuspended(c.req.param("id"), false);
    if (!result) return c.json({ error: "not_found" }, 404);
    return c.json({ team: serializeTeam(repo, result.team) });
  });

  /**
   * 朝礼 / 定例 delegation からチーム面へ報告カードを投稿する。
   *
   * 投稿自体は Discord bot 側 (team-post-card.ts) が team.card_requested を受けて行う。
   * ここは「どのチームの、 どの種別のカードか」 を検証してイベントに載せるだけ。
   */
  app.post("/:id/cards", async (c) => {
    const team = repo.findByIdOrSlug(c.req.param("id"));
    if (!team) return c.json({ error: "not_found" }, 404);
    const parsed = CardSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_card", detail: parsed.error.flatten() }, 400);
    eventBus.emit({
      type: "team.card_requested",
      team_id: team.id,
      kind: parsed.data.kind,
      title: parsed.data.title,
      body: parsed.data.body,
      ts: Math.floor(Date.now() / 1000),
    });
    // 面が未プロビジョニングなら bot 側でスキップされるため、 ここでは受理のみを返す。
    return c.json({ accepted: true, team_id: team.id, kind: parsed.data.kind }, 202);
  });

  return app;
}

const EMPTY_METRICS: TeamMetrics = {
  goal_count: 0,
  active_case_count: 0,
  active_session_count: 0,
  today_cost_tokens: 0,
};

function readPositiveInt(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function serializeTeam(
  repo: TeamsRepo,
  row: TeamRow,
): TeamRow & { settings: TeamSettings; repos: string[]; suspended: boolean } {
  return {
    ...row,
    settings: parseTeamSettings(row),
    repos: repo.repos(row.id),
    suspended: row.suspended_at !== null,
  };
}
