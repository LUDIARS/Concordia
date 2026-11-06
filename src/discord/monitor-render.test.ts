import { describe, expect, it } from "vitest";
import { renderMonitor, renderMonitorPages } from "./monitor-render.js";

describe("renderMonitor", () => {
  it("shows both ordinary channels and forum thread links, unknown and G&G", () => {
    const body = renderMonitor({ activeCount: 2, generatedAt: 1, orgCostLines: [], channelCostLines: [], sessions: [
      { channelId: "111", task: "通常channel", progress: null, goalAndGo: "OFF" },
      { channelId: "222", task: "forum thread", progress: {
        task: "forum thread", percent: 65, evidence: "修正済み", remaining: ["審査"], complete: false, at: "2026-11-06T00:00:00Z",
      }, goalAndGo: "回答待ち" },
    ] });
    expect(body).toContain("<#111>"); expect(body).toContain("<#222>");
    expect(body).toContain("65% (概算)"); expect(body).toContain("進捗未確認");
    expect(body).toContain("根拠: 修正済み"); expect(body).toContain("G&G: 回答待ち");
  });
  it("keeps all session links in bounded stable pages", () => {
    const pages = renderMonitorPages({ activeCount: 100, generatedAt: 1, orgCostLines: [], channelCostLines: [],
      sessions: Array.from({ length: 100 }, (_, i) => ({ channelId: String(i), task: "x".repeat(180), progress: null, goalAndGo: "ON" })) });
    expect(pages.every(page => page.length <= 1850)).toBe(true);
    for (let i = 0; i < 100; i++) expect(pages.join("\n")).toContain(`<#${i}>`);
  });
});
