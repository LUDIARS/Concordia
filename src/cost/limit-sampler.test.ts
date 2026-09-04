import { describe, expect, it } from "vitest";
import { collectLimitSamples } from "./limit-sampler.js";
import type { CostReport } from "./cost-report.js";

function report(): CostReport {
  return {
    codexTotals: { input: 0, cached: 0, output: 0, total: 0 },
    claudeTotals: { input: 0, cached: 0, output: 0, total: 0 },
    codexRate: { used5h: null, usedWeekly: null, reset5hAt: null, resetWeeklyAt: null, plan: null },
    claudeUsage: null,
  };
}

describe("collectLimitSamples", () => {
  it("records what was observed", () => {
    const r = report();
    r.codexRate = { used5h: null, usedWeekly: 63, reset5hAt: null, resetWeeklyAt: 9000, plan: "pro" };

    expect(collectLimitSamples(r, 1600)).toEqual([
      {
        ts: 1600,
        provider: "codex-cli",
        plan: "pro",
        used_5h_pct: null,
        used_weekly_pct: 63,
        reset_5h_at: null,
        reset_weekly_at: 9000,
      },
    ]);
  });

  // 2026-09-03 の障害: Codex は 5H 枠が廃止されて `secondary: null` を返すように
  // なったが、 サンプラーが直近行から欠損を埋めていたため、 7 月に観測した最後の 5H 値
  // (71%) が 2 か月ぶん複製され、 存在しない時系列がグラフに出ていた。 サンプルは
  // 10 分毎に書かれ各行が前の行を継承するので、 「古すぎたら埋めない」という年齢制限を
  // 付けても鎖は切れなかった (前の行はいつでも 10 分前だから)。 埋めるのをやめるのが答え。
  it("never fills a window the provider stopped reporting", () => {
    const r = report();
    r.codexRate = { used5h: null, usedWeekly: 63, reset5hAt: null, resetWeeklyAt: 9000, plan: "pro" };

    // 10 分毎に 30 回 = 5 時間ぶん回しても、 廃止された枠は null のまま。
    for (let i = 1; i <= 30; i += 1) {
      const [sample] = collectLimitSamples(r, 1_000_000 + i * 600);
      expect(sample).toMatchObject({ used_5h_pct: null, reset_5h_at: null, used_weekly_pct: 63 });
    }
  });

  it("skips a provider with no limit telemetry at all", () => {
    // 一時的な取得失敗の穴埋めは取得層 (codex-rate-limits / anthropic-oauth-usage) の
    // 「直近の成功値を 30 分まで返す」が担当する。 そこも尽きたなら記録するものは無い。
    expect(collectLimitSamples(report(), 1600)).toEqual([]);
  });

  it("records both providers when both report", () => {
    const r = report();
    r.codexRate = { used5h: null, usedWeekly: 63, reset5hAt: null, resetWeeklyAt: 9000, plan: "pro" };
    r.claudeUsage = {
      plan: "max",
      fiveHour: { utilization: 40, resetsAtSec: 4000 },
      sevenDay: { utilization: 77, resetsAtSec: 5000 },
      sevenDaySonnet: null,
      sevenDayOpus: null,
      sevenDayFable: null,
      weeklyScoped: [],
      extraCredit: {
        isEnabled: false, monthlyLimit: null, usedCredits: null, utilization: null, currency: null,
      },
      fetchedAt: 0,
    };

    expect(collectLimitSamples(r, 1600).map((s) => s.provider)).toEqual(["codex-cli", "claude-code"]);
    expect(collectLimitSamples(r, 1600)[1]).toMatchObject({
      plan: "max",
      used_5h_pct: 40,
      used_weekly_pct: 77,
      reset_5h_at: 4000,
      reset_weekly_at: 5000,
    });
  });
});
