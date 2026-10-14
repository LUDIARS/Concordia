import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { DayReportsRepo } from "../db/day-reports-repo.js";
import { startDailyScheduler } from "./scheduler.js";
import { generateDayReport } from "./generator.js";
import { buildSiteDayActivity } from "./site-activity.js";

// 日報は本社だけで作る (2026-10-14 neco 指示、 SPEC-FED-SITE-ACTIVITY)。
describe("daily report on HQ and sites", () => {
  beforeEach(() => { vi.stubEnv("CONCORDIA_DISABLE_CLAUDE", "1"); });
  afterEach(() => { vi.unstubAllEnvs(); });

  const sessions = { listSessionsInRange: () => [], allEvents: () => [] } as unknown as SessionsRepo;

  it("拠点ロールでは日報を生成しない", async () => {
    const upsert = vi.fn();
    const dayReports = { find: () => null, upsert } as unknown as DayReportsRepo;
    const handle = startDailyScheduler({ sessions, dayReports, isSiteRole: () => true });
    try {
      await handle.runOnce("2026-10-14");
    } finally {
      handle.stop();
    }
    expect(upsert).not.toHaveBeenCalled();
  });

  it("本社では拠点から届いた記録を拠点ごとの欄として載せる", async () => {
    const report = await generateDayReport("2026-10-14", sessions, [{
      site_id: "mac",
      site_name: "Mac",
      received_at: 1,
      report: buildSiteDayActivity("2026-10-14", [{
        id: "s-1", provider: "claude-code", repo_path: "Concordia", repo_origin: null, branch: "feat/a", host: "mac",
        started_at: 0, ended_at: 60, status: "ended", last_seen_at: 60, current_task: "拠点の作業", transcript_path: null,
        metadata: null, ws_clients: 0, target_project: null,
      }]),
    }]);
    const bullets = JSON.parse(report.bullets) as { sites?: Array<{ site_name: string; session_count: number }> };
    expect(bullets.sites).toEqual([expect.objectContaining({ site_name: "Mac", session_count: 1 })]);
    // 本社の集計値には拠点のセッションを混ぜない。
    expect(report.session_count).toBe(0);
    expect(report.summary_md).toContain("## 拠点: Mac");
    expect(report.summary_md).toContain("拠点の作業");
  });

  it("拠点の欄に拠点のセッションが提出した PR を載せる", async () => {
    const pr = { source: "github" as const, repo: "LUDIARS/Concordia", number: 42, title: "拠点の PR", state: "open", url: "https://github.com/LUDIARS/Concordia/pull/42" };
    const report = await generateDayReport("2026-10-14", sessions, [{
      site_id: "mac",
      site_name: "Mac",
      received_at: 1,
      report: buildSiteDayActivity("2026-10-14", [{
        id: "s-1", provider: "claude-code", repo_path: "Concordia", repo_origin: null, branch: "feat/a", host: "mac",
        started_at: 0, ended_at: 60, status: "ended", last_seen_at: 60, current_task: "拠点の作業", transcript_path: null,
        metadata: null, ws_clients: 0, target_project: null,
      }], 100, undefined, () => [pr]),
    }]);
    const bullets = JSON.parse(report.bullets) as { sites?: Array<{ prs: unknown[] }> };
    expect(bullets.sites?.[0]?.prs).toEqual([pr]);
    expect(report.summary_md).toContain("LUDIARS/Concordia #42 拠点の PR [open]");
  });
});
