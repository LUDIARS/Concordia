import { describe, expect, it } from "vitest";
import type { SessionRow } from "../shared/types.js";
import { buildSiteDayActivity, summarizeSiteActivity, type SiteActivityEntry } from "./site-activity.js";

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
    expect(sites[0]).toMatchObject({ session_count: 1, total_duration_sec: 600, repos: ["E:/Document/Ars/Concordia"], branches: ["feat/a"] });
  });
});
