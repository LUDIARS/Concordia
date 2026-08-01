/**
 * /v1/monitor — frontend 用 集約 endpoint.
 *
 * - GET /            — active / lost / recent_ended の一覧 + repos 集計
 * - GET /conflicts   — 指定 repo (任意で branch) で同時作業中の active session 一覧
 *                       新規ブランチ着手前の競合チェックに使う
 */

import { Hono } from "hono";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { MetricsStore } from "../metrics/store.js";
import type { SessionRow } from "../shared/types.js";
import { probeProjectSufficiency, type ProjectSufficiency } from "../harness/data-sufficiency.js";
import { repoLeaf } from "../harness/predicates.js";
import { serializeSession } from "./sessions.js";
import { isWorkspaceRootRepo } from "../control/conflict-scope.js";

export interface MonitorApiDeps {
  repo: SessionsRepo;
  /** umbrella workspace roots are containers, not work targets. */
  resolveWorkspaceRoots?: () => string[];
  /** ホストメトリクスの読み出し (省略時は metrics 機能無効として 503)。 */
  metrics?: MetricsStore;
}

export function monitorRouter(deps: MonitorApiDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const active = deps.repo.listSessions({ status: "active" });
    const lost = deps.repo.listSessions({ status: "lost" });
    const recentEnded = deps.repo.listSessions({ status: "ended" }).slice(0, 20);
    const repos = new Map<string, number>();
    for (const s of active) {
      const k = s.repo_origin ?? s.repo_path;
      repos.set(k, (repos.get(k) ?? 0) + 1);
    }
    return c.json({
      active: await serializeSessionsWithLastUserMessage(deps.repo, active),
      lost: lost.map(serializeSession),
      recent_ended: recentEnded.map(serializeSession),
      repos: [...repos.entries()].map(([key, count]) => ({ key, count })),
    });
  });

  /**
   * 新規ブランチ着手前の競合チェック.
   * - repo: repo_path もしくは repo_origin と一致する active session が対象
   * - branch: 「同じブランチで作業しているか」 を判定する軸. 同じブランチでない限り
   *           conflict には載せない (= ブランチ分離されていれば作業衝突しない方針).
   *           query で省略 / 空文字なら「ブランチ無し (null)」 と同義として扱う.
   * - exclude_session: 自分自身など除外したい session_id
   *
   * 補助情報:
   * - `branches[]` は repo 全体 (= caller の branch に関係なく) で動いている active
   *   session を branch 別に集計したもの. caller が他ブランチの作業状況も俯瞰できる.
   * - `conflicts[]` は厳密に (repo, branch) が一致する session だけ (caller branch
   *   が null なら相手も branch=null の場合のみ). UI 警告 / lictor titleMark の根拠.
   */
  app.get("/conflicts", (c) => {
    const repo = (c.req.query("repo") ?? "").trim();
    const branchQuery = (c.req.query("branch") ?? "").trim();
    const exclude = (c.req.query("exclude_session") ?? "").trim();
    if (!repo) return c.json({ error: "repo query param required" }, 400);
    const callerBranch: string | null = branchQuery === "" ? null : branchQuery;
    const workspaceRoot = isWorkspaceRootRepo(repo, deps.resolveWorkspaceRoots?.() ?? []);
    if (workspaceRoot) {
      return c.json({
        repo,
        branch: callerBranch,
        workspace_root: true,
        conflicts: [],
        branches: [],
      });
    }

    const all = deps.repo.listSessions({ status: "active" });

    // repo 一致 (caller 自身は除外) — branches 集計の母集団.
    const sameRepo = all.filter((s) => {
      if (s.id === exclude) return false;
      return s.repo_path === repo || s.repo_origin === repo;
    });

    // conflicts は (repo, branch) 両方一致した時だけ. caller branch=null なら s.branch
    // も null の時だけ衝突として扱う (両方とも detached / branch 未取得な場合).
    const matching = sameRepo.filter((s) => (s.branch ?? null) === callerBranch);

    // branches 集計は repo 全体 (caller branch に関係なし) — UI で他ブランチの動きも見せたい.
    const byBranch = new Map<string, number>();
    for (const s of sameRepo) {
      const b = s.branch ?? "(detached)";
      byBranch.set(b, (byBranch.get(b) ?? 0) + 1);
    }

    return c.json({
      repo,
      branch: callerBranch,
      workspace_root: false,
      conflicts: matching.map(serializeSession),
      branches: [...byBranch.entries()].map(([branch, count]) => ({ branch, count })),
    });
  });

  // PC パフォーマンス: 最新スナップショット (host メモリ/CPU + 上位プロセス
  // + セッション別 RSS)。 Monitor ページのマシン概況 + セッション別メモリ列に使う。
  app.get("/metrics", (c) => {
    if (!deps.metrics) return c.json({ error: "metrics disabled" }, 503);
    const snapshot = deps.metrics.latest();
    if (!snapshot) return c.json({ snapshot: null });
    return c.json({ snapshot });
  });

  // セッション別 RSS の時系列 (sparkline 用)。
  app.get("/metrics/session/:id", (c) => {
    if (!deps.metrics) return c.json({ error: "metrics disabled" }, 503);
    const id = c.req.param("id");
    const windowMin = Math.max(1, Math.min(1440, Number(c.req.query("window_min") ?? 120)));
    const series = deps.metrics.sessionSeries(id, Date.now() - windowMin * 60_000);
    return c.json({ session_id: id, window_min: windowMin, series });
  });

  return app;
}

async function serializeSessionsWithLastUserMessage(repo: SessionsRepo, sessions: SessionRow[]) {
  const promptEvents = repo.latestEventsByKind(sessions.map((s) => s.id), "prompt");
  const messagesBySession = new Map(
    promptEvents.map((ev) => [ev.session_id, extractPromptText(ev.payload)]),
  );
  const sufficiencyByProject = await probeSufficiencyByProject(sessions);
  return sessions.map((s) => ({
    ...serializeSession(s),
    last_user_message: messagesBySession.get(s.id) ?? null,
    sufficiency: sufficiencyByProject.get(repoLeaf(s.target_project ?? s.repo_path)),
  }));
}

async function probeSufficiencyByProject(sessions: SessionRow[]): Promise<Map<string, ProjectSufficiency>> {
  const projects = new Map<string, string>();
  for (const session of sessions) {
    const project = session.target_project ?? session.repo_path;
    const key = repoLeaf(project);
    if (!projects.has(key)) projects.set(key, project);
  }
  const entries = await Promise.all(
    [...projects.entries()].map(async ([key, project]) => {
      const value = await probeProjectSufficiency(project).catch(() => ({
        project: key,
        anatomia: { present: false },
        thaleia: { present: false },
      } satisfies ProjectSufficiency));
      return [key, value] as const;
    }),
  );
  return new Map(entries);
}

function extractPromptText(payloadJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  const raw = pickPromptText(parsed);
  if (!raw) return null;
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > 500 ? `${compact.slice(0, 500)}...` : compact;
}

function pickPromptText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  for (const key of ["summary", "text", "prompt", "message"]) {
    if (typeof obj[key] === "string") return obj[key];
  }
  return null;
}
