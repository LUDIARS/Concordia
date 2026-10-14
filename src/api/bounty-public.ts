/**
 * パブリックイシューの読み出し API (spec/feature/bug-bounty.md §8)。 Actio が呼ぶ。 GET だけ。
 *
 *   GET /v1/bounty/public-reports?project=<code>  公開してよいバウンティのイシュー
 *   GET /v1/projects/public-issues                公開プロジェクトのコード一覧
 *
 * 返すのは §8 の一覧の項目だけ: 公開用の題名と要約、深刻度、状態、公開名、報奨のトークン数、受付と反映の時刻、
 * 対応する Actio タスクの参照 (報告 id = sourceRef)。 原文・受付口・プラットフォームの id・判定の内部理由は返さない
 * (CC-BOUNTY-INV-07)。 公開してよいかは純関数 (public-view.ts) で決め、判定できなければ出さない。
 *
 * @implements SPEC-BOUNTY-PUBLIC
 */

import { Hono } from "hono";
import { decideBountyPublication, toBountyPublicReport } from "../bounty/public-view.js";
import { displayPublicName } from "../bounty/reporter.js";
import type { BountyReportSummaryRow } from "../db/bounty-reports-repo.js";
import type { BountyReporterRow } from "../db/bounty-reporters-repo.js";

/** プロジェクトコードの形 (project registry のコード)。 */
const PROJECT_CODE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u;
const MAX_PUBLIC_REPORTS = 200;

export interface BountyPublicApiDeps {
  reports: { listAcceptedForProject(project: string, limit: number): BountyReportSummaryRow[] };
  reporters: { find(id: string): BountyReporterRow | null };
  /** プロジェクトの `public_issues`。 未登録なら null。 */
  projectPublic(code: string): boolean | null;
  publicProjects(): Array<{ code: string; project: string }>;
}

function reporterOf(row: BountyReportSummaryRow, deps: BountyPublicApiDeps): string {
  const named = row.reporter_kind === "person" ? row.reporter_id : row.recipient_reporter_id;
  const publicName = named ? deps.reporters.find(named)?.public_name ?? null : null;
  return displayPublicName({ kind: row.reporter_kind, publicName });
}

/** `/v1/bounty` の配下。 */
export function bountyPublicRouter(deps: BountyPublicApiDeps): Hono {
  const app = new Hono();
  app.get("/public-reports", (c) => {
    const project = c.req.query("project") ?? "";
    if (!PROJECT_CODE.test(project)) return c.json({ error: "invalid_project" }, 400);
    const isPublic = deps.projectPublic(project);
    // 未登録・非公開のプロジェクトは、存在を区別せず空で返す。
    if (isPublic !== true) return c.json({ project, reports: [] });
    const reports = deps.reports.listAcceptedForProject(project, MAX_PUBLIC_REPORTS)
      .filter((row) => row.project_code !== null && decideBountyPublication({
        projectPublic: isPublic,
        verdict: row.verdict,
        status: row.status,
        sensitive: row.sensitive === 1,
      }))
      .map((row) => toBountyPublicReport({ ...row, project_code: row.project_code! }, reporterOf(row, deps)));
    return c.json({ project, reports });
  });
  return app;
}

/** `/v1/projects` の配下。 */
export function publicIssuesProjectsRouter(deps: Pick<BountyPublicApiDeps, "publicProjects">): Hono {
  const app = new Hono();
  app.get("/public-issues", (c) => c.json({
    projects: deps.publicProjects().map((row) => ({ code: row.code, project: row.project })),
  }));
  return app;
}
