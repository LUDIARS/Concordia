/**
 * /v1/session-logs API — 過去の作業ログ (`<workspaceRoot>/session-logs/*.md`) を
 * 一覧・per-project 閲覧・全文取得する。 Web ダッシュボードと MCP (作業引き継ぎ) の
 * 共通バックエンド。
 */
import { Hono } from "hono";
import {
  resolveSessionLogsDir,
  readSessionLogs,
  readSessionLogFull,
} from "../session-logs/reader.js";

export interface SessionLogsApiDeps {
  /** workspace ルート群 (= ローカルクローン親)。 `<root>/session-logs` を探す。 */
  resolveWorkspaceRoots: () => string[];
  /**
   * プロジェクト正式名の語彙。 正本は project code registry で、 ここは
   * その読み取り経路を注入するだけ。 空なら session-log にタグを付けない
   * (spec/plan/2026-09-04-externalize-partner-identifiers.md)。
   */
  resolveProjectNames: () => string[];
}

function resolveProjectNamesOrEmpty(deps: SessionLogsApiDeps): string[] {
  try {
    return deps.resolveProjectNames();
  } catch {
    // Registry 障害時に組み込み語彙へ戻すと外出しが崩れる。タグ無しで一覧は提供する。
    return [];
  }
}

function clampInt(raw: string | undefined, def: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function sessionLogsRouter(deps: SessionLogsApiDeps): Hono {
  const app = new Hono();

  // GET /v1/session-logs?project=&q=&limit= — 一覧 + プロジェクト facet。
  // facet (projects) は全件から算出するので、 project/q で絞っても安定して出る。
  app.get("/", async (c) => {
    const dir = await resolveSessionLogsDir(deps.resolveWorkspaceRoots());
    const all = dir ? await readSessionLogs(dir, resolveProjectNamesOrEmpty(deps)) : [];

    const counts = new Map<string, number>();
    for (const e of all) for (const p of e.projects) counts.set(p, (counts.get(p) ?? 0) + 1);
    const projects = [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const project = c.req.query("project")?.trim();
    const q = c.req.query("q")?.trim().toLowerCase();
    const limit = clampInt(c.req.query("limit"), 200, 1, 1000);

    let entries = all;
    if (project) entries = entries.filter((e) => e.projects.includes(project));
    if (q) {
      entries = entries.filter((e) =>
        `${e.title} ${e.sections.join(" ")} ${e.excerpt}`.toLowerCase().includes(q),
      );
    }
    const total_matched = entries.length;
    entries = entries.slice(0, limit);

    return c.json({ root: dir, total: all.length, total_matched, projects, entries });
  });

  // GET /v1/session-logs/:id — 1 件の本文込み詳細。
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const dir = await resolveSessionLogsDir(deps.resolveWorkspaceRoots());
    if (!dir) return c.json({ error: "no_session_logs_dir" }, 404);
    const full = await readSessionLogFull(dir, id, resolveProjectNamesOrEmpty(deps));
    if (!full) return c.json({ error: "not_found" }, 404);
    return c.json(full);
  });

  return app;
}
