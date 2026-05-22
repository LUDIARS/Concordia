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
   * - repo: repo_path もしくは repo_origin と一致する active session を返す
   * - branch: 指定があればそのブランチで作業中のものに絞る
   * - exclude_session: 自分自身など除外したい session_id
   */
  app.get("/conflicts", (c) => {
    const repo = (c.req.query("repo") ?? "").trim();
    const branch = (c.req.query("branch") ?? "").trim();
    const exclude = (c.req.query("exclude_session") ?? "").trim();
    if (!repo) return c.json({ error: "repo query param required" }, 400);

    const all = deps.repo.listSessions({ status: "active" });
    const matching = all.filter((s) => {
      if (s.id === exclude) return false;
      const sameRepo = s.repo_path === repo || s.repo_origin === repo;
      if (!sameRepo) return false;
      if (branch && s.branch !== branch) return false;
      return true;
    });

    // ブランチ別 active 数 (モニター可視化に便利)
    const byBranch = new Map<string, number>();
    for (const s of matching) {
      const b = s.branch ?? "(detached)";
      byBranch.set(b, (byBranch.get(b) ?? 0) + 1);
    }

    return c.json({
      repo,
      branch: branch || null,
      conflicts: matching.map(serializeSession),
      branches: [...byBranch.entries()].map(([branch, count]) => ({ branch, count })),
    });
  });

  return app;
}
