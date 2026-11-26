import { describe, it, expect } from "vitest";
import {
  renderCostReportMarkdown,
  type CostReport,
  type CostTimestampFormat,
} from "./cost-report.js";

// Discord 形式 (`<t:..>` トークン)。
const DISCORD_FMT: CostTimestampFormat = {
  updated: (s) => `<t:${s}:R>`,
  at: (s) => (s === null ? "-" : `<t:${s}:f> (<t:${s}:R>)`),
};

// Slack 形式 (素テキストの代用; 本番は JST だがここでは決定的な簡易表現)。
const PLAIN_FMT: CostTimestampFormat = {
  updated: (s) => `t=${s}`,
  at: (s) => (s === null ? "-" : `t=${s}`),
};

function baseReport(): CostReport {
  return {
    codexTotals: { input: 100, cached: 20, output: 30, total: 150 },
    claudeTotals: { input: 200, cached: 40, output: 60, total: 300 },
    geminiTotals: { input: 300, cached: 50, output: 40, total: 390 },
    codexRate: { used5h: 40, usedWeekly: 10, reset5hAt: 1000, resetWeeklyAt: 2000, plan: "pro" },
    claudeUsage: {
      plan: "max",
      fiveHour: { utilization: 25, resetsAtSec: 3000 },
      sevenDay: { utilization: 5, resetsAtSec: 4000 },
      sevenDaySonnet: null,
      sevenDayOpus: null,
      sevenDayFable: null,
      weeklyScoped: [],
      extraCredit: { isEnabled: false, monthlyLimit: null, usedCredits: null, utilization: null, currency: null },
      fetchedAt: 0,
    },
  };
}

describe("renderCostReportMarkdown", () => {
  it("renders Grok's weekly remaining percent and reset", () => {
    const grokUsage = { usedWeeklyPct: 1, resetWeeklyAt: 9000, plan: "SuperGrok", observedAtSec: 1500 };
    const md = renderCostReportMarkdown({ ...baseReport(), grokUsage }, PLAIN_FMT, 1600);
    expect(md).toContain("### Grok\n- 週間リミット残: 99.0%\n- 週間リセット: t=9000\n");
    expect(renderCostReportMarkdown(baseReport(), PLAIN_FMT, 1600))
      .toContain("### Grok\n- 週間リミット残: -\n- 週間リセット: -\n");
  });

  it("見出し・プロバイダ別トークン・残量を本文に出す", () => {
    const md = renderCostReportMarkdown(baseReport(), PLAIN_FMT, 1234);
    expect(md).toContain("## コスト / 使用量");
    expect(md).toContain("- Updated: t=1234");
    expect(md).toContain("### Codex");
    expect(md).toContain("Tokens: 150 (in=100, cached=20, out=30)");
    expect(md).toContain("### Claude Code");
    expect(md).toContain("Tokens: 300 (in=200, cached=40, out=60)");
    expect(md).toContain("### Gemini\n- Tokens: 390 (in=300, cached=50, out=40)");
    // remain = 100 - used。 Codex は週間枠のみ (5H 枠は仕様上なくなった、2026-09-03)。 used=10 → 残 90.0%
    expect(md).toContain("週間リミット残: 90.0%");
    expect(md).not.toContain("5H リミット残: 60.0%");
    // Claude 5H utilization=25 → 残 75.0%
    expect(md).toContain("5H リミット残: 75.0%");
  });

  it("モデル別週間枠 (Fable 等) があれば行が増える (2026-09-03)", () => {
    const r = baseReport();
    r.claudeUsage!.weeklyScoped = [{ label: "Fable", utilization: 90, resetsAtSec: 7000, severity: "critical" }];
    const md = renderCostReportMarkdown(r, PLAIN_FMT, 1);
    expect(md).toContain("週間 Fable 残: 10.0% (リセット t=7000)");
  });

  it("Gemini 節に agy /usage の 5H / 週間リミット残を出す (2026-11-21)", () => {
    const r = baseReport();
    r.geminiUsage = {
      fiveHour: { usedPct: 8, resetsAtSec: 5000 },
      weekly: { usedPct: 2, resetsAtSec: 6000 },
      others: [],
      fetchedAt: 0,
    };
    const md = renderCostReportMarkdown(r, PLAIN_FMT, 1);
    expect(md).toContain("### Gemini\n- Tokens: 390 (in=300, cached=50, out=40)\n- 5H リミット残: 92.0%\n- 週間リミット残: 98.0%\n- 5H リセット: t=5000\n- 週間リセット: t=6000");
  });

  it("Gemini の利用枠が取れなければ取得失敗と分かる表示にする", () => {
    const md = renderCostReportMarkdown({ ...baseReport(), geminiUsage: null }, PLAIN_FMT, 1);
    expect(md).toContain("### Gemini\n- Tokens: 390 (in=300, cached=50, out=40)\n- 5H リミット残: - (agy /usage 取得失敗)");
  });

  it("OAuth usage が null なら Claude 残量はフォールバック表示", () => {
    const r = baseReport();
    r.claudeUsage = null;
    const md = renderCostReportMarkdown(r, PLAIN_FMT, 1);
    expect(md).toContain("5H リミット残: - (OAuth usage 取得失敗)");
  });

  it("Sonnet/Opus/追加クレジットがあれば行が増える", () => {
    const r = baseReport();
    r.claudeUsage!.sevenDaySonnet = { utilization: 50, resetsAtSec: 5000 };
    r.claudeUsage!.sevenDayOpus = { utilization: 90, resetsAtSec: 6000 };
    r.claudeUsage!.extraCredit = { isEnabled: true, monthlyLimit: 100, usedCredits: 30, utilization: 30, currency: "USD" };
    const md = renderCostReportMarkdown(r, PLAIN_FMT, 1);
    expect(md).toContain("週間 Sonnet 残: 50.0%");
    expect(md).toContain("週間 Opus 残: 10.0%");
    expect(md).toContain("追加クレジット使用率: 30.0%");
  });

  it("formatter 差分: 同じデータでもタイムスタンプ表現だけが変わる (本文は共通)", () => {
    const r = baseReport();
    const discord = renderCostReportMarkdown(r, DISCORD_FMT, 1234);
    const plain = renderCostReportMarkdown(r, PLAIN_FMT, 1234);
    // Discord はトークン表現
    expect(discord).toContain("- Updated: <t:1234:R>");
    expect(discord).toContain("週間リセット: <t:2000:f> (<t:2000:R>)");
    // 素テキストは別表現
    expect(plain).toContain("- Updated: t=1234");
    expect(plain).toContain("週間リセット: t=2000");
    // タイムスタンプ以外の本文 (トークン行) は両者一致
    expect(discord).toContain("Tokens: 150 (in=100, cached=20, out=30)");
    expect(plain).toContain("Tokens: 150 (in=100, cached=20, out=30)");
  });
});
