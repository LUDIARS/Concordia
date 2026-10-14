import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { activityReportBytes, buildSiteDayActivity, summarizeSiteActivity, type SiteActivityEntry } from "./site-activity.js";
import {
  ACTIVITY_REPORT_MAX_BYTES,
  ACTIVITY_REPORT_MAX_PRS,
  ACTIVITY_REPORT_MAX_SESSIONS,
  ACTIVITY_SESSION_MAX_PRS,
  type FederationActivityPr,
} from "../federation/protocol.js";

function session(patch: Partial<SessionRow>): SessionRow {
  return {
    id: "s-1",
    provider: "claude-code",
    repo_path: "E:/Document/Ars/Concordia",
    repo_origin: null,
    branch: "main",
    host: "site-pc",
    started_at: 1_000,
    ended_at: 1_600,
    status: "ended",
    last_seen_at: 1_600,
    current_task: "日報の修正",
    transcript_path: null,
    metadata: JSON.stringify({ secret: "do-not-send" }),
    ws_clients: 0,
    target_project: null,
    ...patch,
  } as SessionRow;
}

describe("buildSiteDayActivity", () => {
  it("送るのは題名・場所・状態・時間だけで、 metadata は送らない", () => {
    const report = buildSiteDayActivity("2026-10-14", [session({})], 9_999);
    expect(report).toEqual({
      date_iso: "2026-10-14",
      generated_at: 9_999,
      session_count: 1,
      sessions: [{
        id: "s-1",
        title: "日報の修正",
        repo: "E:/Document/Ars/Concordia",
        branch: "main",
        provider: "claude-code",
        status: "ended",
        started_at: 1_000,
        ended_at: 1_600,
        duration_sec: 600,
      }],
    });
    expect(JSON.stringify(report)).not.toContain("do-not-send");
  });

  it("新しい順に上限まで載せ、 総数は session_count に残す", () => {
    const sessions = [1, 2, 3].map((n) => session({ id: `s-${n}`, started_at: n * 100 }));
    const report = buildSiteDayActivity("2026-10-14", sessions, 0, 2);
    expect(report.session_count).toBe(3);
    expect(report.sessions.map((s) => s.id)).toEqual(["s-3", "s-2"]);
  });

  it("実行中は最終確認時刻までの時間にし、 長い題名は切る", () => {
    const report = buildSiteDayActivity("2026-10-14", [session({ ended_at: null, status: "active", last_seen_at: 1_300, current_task: "x".repeat(300) })]);
    expect(report.sessions[0]).toMatchObject({ ended_at: null, duration_sec: 300 });
    expect(report.sessions[0]!.title!.length).toBe(200);
  });
});

describe("summarizeSiteActivity", () => {
  it("拠点名順に、 総数・時間・リポジトリ・ブランチをまとめる", () => {
    const entry = (siteId: string, siteName: string): SiteActivityEntry => ({
      site_id: siteId,
      site_name: siteName,
      received_at: 1,
      report: buildSiteDayActivity("2026-10-14", [session({ id: `${siteId}-1`, branch: "feat/a" })]),
    });
    const sites = summarizeSiteActivity([entry("mac", "Mac"), entry("aws", "AWS")]);
    expect(sites.map((s) => s.site_name)).toEqual(["AWS", "Mac"]);
    expect(sites[0]).toMatchObject({ session_count: 1, total_duration_sec: 600, repos: ["E:/Document/Ars/Concordia"], branches: ["feat/a"], prs: [] });
  });

  it("拠点のセッションの PR を重複なしでまとめ、 PR を送らない旧版の拠点の記録も受け付ける", () => {
    const pr: FederationActivityPr = { source: "local", repo: "LUDIARS/Concordia", number: 7, title: "直した", state: "open", url: null };
    const newer: SiteActivityEntry = {
      site_id: "mac",
      site_name: "Mac",
      received_at: 1,
      report: buildSiteDayActivity("2026-10-14", [session({ id: "a", started_at: 2_000 }), session({ id: "b" })], 9_999, undefined, () => [pr]),
    };
    const legacy: SiteActivityEntry = {
      site_id: "aws",
      site_name: "AWS",
      received_at: 1,
      report: { date_iso: "2026-10-14", generated_at: 1, session_count: 1, sessions: [{ id: "x", title: null, repo: null, branch: null, provider: "codex", status: "ended", started_at: 1, ended_at: 2, duration_sec: 1 }] },
    };
    const [aws, mac] = summarizeSiteActivity([newer, legacy]);
    expect(aws?.prs).toEqual([]);
    expect(mac?.prs).toEqual([pr]);
  });
});

describe("buildSiteDayActivity with PRs", () => {
  const pr = (n: number): FederationActivityPr => ({ source: "github", repo: "LUDIARS/Concordia", number: n, title: `PR ${n}`, state: "merged", url: `https://github.com/LUDIARS/Concordia/pull/${n}` });

  it("セッションごとに PR を載せ、 PR の無いセッションには prs を付けない", () => {
    const report = buildSiteDayActivity("2026-10-14", [session({ id: "a" }), session({ id: "b", started_at: 500 })], 9_999, undefined, (id) => (id === "a" ? [pr(1)] : []));
    expect(report.sessions.find((s) => s.id === "a")?.prs).toEqual([pr(1)]);
    expect(report.sessions.find((s) => s.id === "b")).not.toHaveProperty("prs");
  });

  it("PR はセッションあたり・報告全体の上限まで、 新しいセッションから載せる", () => {
    const many = Array.from({ length: 10 }, (_, i) => pr(i + 1));
    const rows = Array.from({ length: 30 }, (_, i) => session({ id: `s-${i}`, started_at: 10_000 - i }));
    const report = buildSiteDayActivity("2026-10-14", rows, 9_999, undefined, () => many, Number.MAX_SAFE_INTEGER);
    expect(report.sessions[0]?.prs).toHaveLength(ACTIVITY_SESSION_MAX_PRS);
    expect(report.sessions.reduce((n, s) => n + (s.prs?.length ?? 0), 0)).toBe(ACTIVITY_REPORT_MAX_PRS);
    expect(report.sessions.at(-1)).not.toHaveProperty("prs");
  });

  it("直列化が上限バイトを超えるときは古いセッションから落とし、 総数は残す", () => {
    const rows = Array.from({ length: ACTIVITY_REPORT_MAX_SESSIONS }, (_, i) => session({ id: `s-${i}`, started_at: 10_000 - i, current_task: "あ".repeat(300) }));
    const report = buildSiteDayActivity("2026-10-14", rows, 9_999, undefined, () => [pr(1), pr(2)]);
    expect(activityReportBytes(report)).toBeLessThanOrEqual(ACTIVITY_REPORT_MAX_BYTES);
    expect(report.sessions.length).toBeLessThan(ACTIVITY_REPORT_MAX_SESSIONS);
    expect(report.sessions[0]?.id).toBe("s-0");
    expect(report.session_count).toBe(ACTIVITY_REPORT_MAX_SESSIONS);
  });
});
