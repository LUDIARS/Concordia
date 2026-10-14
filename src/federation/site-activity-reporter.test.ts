import { describe, expect, it, vi } from "vitest";
import { reportSiteActivityOnce } from "./site-activity-reporter.js";
import type { SiteDayActivity } from "../daily/site-activity.js";
import type { SessionRow } from "../shared/types.js";

const NOW = new Date(2026, 9, 14, 9, 0, 0);

const row = {
  id: "s-1", provider: "claude-code", repo_path: "Concordia", repo_origin: null, branch: "feat/a", host: "mac",
  started_at: 0, ended_at: 60, status: "ended", last_seen_at: 60, current_task: "拠点の作業", transcript_path: null,
  metadata: null, ws_clients: 0, target_project: null,
} as unknown as SessionRow;

describe("reportSiteActivityOnce", () => {
  it("本社 (拠点ロールでない) では何も送らない", async () => {
    const send = vi.fn(() => true);
    const listSessionsInRange = vi.fn(() => []);
    expect(await reportSiteActivityOnce({ isSiteRole: () => false, listSessionsInRange, send, now: () => NOW })).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(listSessionsInRange).not.toHaveBeenCalled();
  });

  it("拠点ロールでは今日と昨日の記録を送る", async () => {
    const send = vi.fn((_report: SiteDayActivity) => true);
    const sent = await reportSiteActivityOnce({ isSiteRole: () => true, listSessionsInRange: () => [], send, now: () => NOW });
    expect(sent).toEqual(["2026-10-14", "2026-10-13"]);
    expect(send.mock.calls.map(([report]) => report.date_iso)).toEqual(["2026-10-14", "2026-10-13"]);
  });

  it("本社との接続が切れていて送れなかった日は送信済みにしない", async () => {
    const sent = await reportSiteActivityOnce({ isSiteRole: () => true, listSessionsInRange: () => [], send: () => false, now: () => NOW });
    expect(sent).toEqual([]);
  });

  it("セッションが提出した PR を載せて送る", async () => {
    const reports: SiteDayActivity[] = [];
    const pr = { source: "local" as const, repo: "LUDIARS/Concordia", number: 3, title: "拠点の PR", state: "open", url: null };
    const listSessionPrs = vi.fn(async () => new Map([["s-1", [pr]]]));
    await reportSiteActivityOnce({
      isSiteRole: () => true,
      listSessionsInRange: () => [row],
      listSessionPrs,
      send: (report) => { reports.push(report); return true; },
      now: () => NOW,
    });
    expect(listSessionPrs).toHaveBeenCalledTimes(1);
    expect(reports[0]?.sessions[0]?.prs).toEqual([pr]);
  });

  it("PR の取得に失敗しても PR なしで記録を送る", async () => {
    const reports: SiteDayActivity[] = [];
    const sent = await reportSiteActivityOnce({
      isSiteRole: () => true,
      listSessionsInRange: () => [row],
      listSessionPrs: async () => { throw new Error("revisor down"); },
      send: (report) => { reports.push(report); return true; },
      now: () => NOW,
    });
    expect(sent).toEqual(["2026-10-14", "2026-10-13"]);
    expect(reports[0]?.sessions[0]).not.toHaveProperty("prs");
  });
});
