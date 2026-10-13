import { describe, expect, it, vi } from "vitest";
import { reportSiteActivityOnce } from "./site-activity-reporter.js";

const NOW = new Date(2026, 9, 14, 9, 0, 0);

describe("reportSiteActivityOnce", () => {
  it("本社 (拠点ロールでない) では何も送らない", () => {
    const send = vi.fn(() => true);
    const listSessionsInRange = vi.fn(() => []);
    expect(reportSiteActivityOnce({ isSiteRole: () => false, listSessionsInRange, send, now: () => NOW })).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(listSessionsInRange).not.toHaveBeenCalled();
  });

  it("拠点ロールでは今日と昨日の記録を送る", () => {
    const send = vi.fn(() => true);
    const sent = reportSiteActivityOnce({ isSiteRole: () => true, listSessionsInRange: () => [], send, now: () => NOW });
    expect(sent).toEqual(["2026-10-14", "2026-10-13"]);
    expect(send.mock.calls.map(([report]) => (report as { date_iso: string }).date_iso)).toEqual(["2026-10-14", "2026-10-13"]);
  });

  it("本社との接続が切れていて送れなかった日は送信済みにしない", () => {
    const sent = reportSiteActivityOnce({ isSiteRole: () => true, listSessionsInRange: () => [], send: () => false, now: () => NOW });
    expect(sent).toEqual([]);
  });
});
