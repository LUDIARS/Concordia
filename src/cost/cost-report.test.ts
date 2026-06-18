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
    codexRate: { used5h: 40, usedWeekly: 10, reset5hAt: 1000, resetWeeklyAt: 2000 },
    claudeUsage: {
      fiveHour: { utilization: 25, resetsAtSec: 3000 },
      sevenDay: { utilization: 5, resetsAtSec: 4000 },
      sevenDaySonnet: null,
      sevenDayOpus: null,
      extraCredit: { isEnabled: false, monthlyLimit: null, usedCredits: null, utilization: null, currency: null },
      fetchedAt: 0,
    },
  };
}

describe("renderCostReportMarkdown", () => {
  it("見出し・プロバイダ別トークン・残量を本文に出す", () => {
    const md = renderCostReportMarkdown(baseReport(), PLAIN_FMT, 1234);
    expect(md).toContain("## コスト / 使用量");
    expect(md).toContain("- Updated: t=1234");
    expect(md).toContain("### Codex");
    expect(md).toContain("Tokens: 150 (in=100, cached=20, out=30)");
    expect(md).toContain("### Claude Code");
    expect(md).toContain("Tokens: 300 (in=200, cached=40, out=60)");
    // remain = 100 - used。 Codex 5H used=40 → 残 60.0%
    expect(md).toContain("5H リミット残: 60.0%");
    // Claude 5H utilization=25 → 残 75.0%
    expect(md).toContain("5H リミット残: 75.0%");
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
    expect(discord).toContain("5H リセット: <t:1000:f> (<t:1000:R>)");
    // 素テキストは別表現
    expect(plain).toContain("- Updated: t=1234");
    expect(plain).toContain("5H リセット: t=1000");
    // タイムスタンプ以外の本文 (トークン行) は両者一致
    expect(discord).toContain("Tokens: 150 (in=100, cached=20, out=30)");
    expect(plain).toContain("Tokens: 150 (in=100, cached=20, out=30)");
  });
});
