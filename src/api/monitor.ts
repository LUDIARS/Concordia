/**
 * /v1/monitor — frontend 用 集約 endpoint.
 *
 * - GET /            — active / lost / recent_ended の一覧 + repos 集計
 * - GET /conflicts   — 指定 repo (任意で branch) で同時作業中の active session 一覧
 *                       新規ブランチ着手前の競合チェックに使う
 */

import { Hono } from "hono";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { serializeSession } from "./sessions.js";

export interface MonitorApiDeps {
  repo: SessionsRepo;
}

export function monitorRouter(deps: MonitorApiDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const active = deps.repo.listSessions({ status: "active" });
    const lost = deps.repo.listSessions({ status: "lost" });
    const recentEnded = deps.repo.listSessions({ status: "ended" }).slice(0, 20);
    const repos = new Map<string, number>();
    for (const s of active) {
      const k = s.repo_origin ?? s.repo_path;
      repos.set(k, (repos.get(k) ?? 0) + 1);
    }
    return c.json({
      active: active.map(serializeSession),
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
      conflicts: matching.map(serializeSession),
      branches: [...byBranch.entries()].map(([branch, count]) => ({ branch, count })),
    });
  });

  return app;
}
