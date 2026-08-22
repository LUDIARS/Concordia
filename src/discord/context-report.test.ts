import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRow } from "../shared/types.js";

// vitest.config.ts は isolate:false なので module registry がファイル間で共有される。
// 同じ context-estimate.js を chat-read-models.test.ts も mock しており、先に評価された
// factory の vi.fn が context-report.ts に束縛されてしまう。 各テストで resetModules して
// import し直し、この file の mock 実体だけを見るようにする。
vi.mock("../cost/context-estimate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cost/context-estimate.js")>()),
  estimateContextTokens: vi.fn(),
}));

import type { ContextEstimate } from "../cost/context-estimate.js";

const estimate: ContextEstimate = { tokens: 50_000, windowTokens: 200_000, pct: 0.25 };

type ContextReportModule = typeof import("./context-report.js");
type EstimateModule = typeof import("../cost/context-estimate.js");

let mod: ContextReportModule;
let estimateContextTokens: EstimateModule["estimateContextTokens"];

beforeEach(async () => {
  vi.resetModules();
  ({ estimateContextTokens } = await import("../cost/context-estimate.js"));
  vi.mocked(estimateContextTokens).mockReset();
  mod = await import("./context-report.js");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("formatContextReport", () => {
  it("占有 / 残量 / しきい値までの余裕を整形する", () => {
    const report = mod.formatContextReport(estimate, 0.75, null);
    expect(report).toContain("🧠 **コンテキスト残量**");
    expect(report).toContain(`占有: ${(50_000).toLocaleString()} / ${(200_000).toLocaleString()} tokens (25%)`);
    expect(report).toContain(`残量: ${(150_000).toLocaleString()} tokens (75%)`);
    // しきい値 75% = 150,000 tokens、現在 50,000 → 余裕 100,000。
    expect(report).toContain(`自動発火しきい値まで: ${(100_000).toLocaleString()} tokens (75% threshold)`);
    expect(report).toContain("前回コンパクション: 未実行");
  });

  it("前回コンパクション時刻を ISO で表示する", () => {
    const at = Date.UTC(2026, 7, 14, 3, 0, 0);
    expect(mod.formatContextReport(estimate, 0.75, at)).toContain("前回コンパクション: 2026-08-14T03:00:00.000Z");
  });

  it("窓超過時も残量・余裕を 0 に clamp する", () => {
    const over: ContextEstimate = { tokens: 250_000, windowTokens: 200_000, pct: 1 };
    const report = mod.formatContextReport(over, 0.75, null);
    expect(report).toContain("残量: 0 tokens (0%)");
    expect(report).toContain("自動発火しきい値まで: 0 tokens");
  });
});

describe("buildContextReport", () => {
  const session = { id: "session-1", metadata: null } as SessionRow;

  it("推定不能なら fallback メッセージを返す", async () => {
    vi.mocked(estimateContextTokens).mockResolvedValue(null);
    expect(await mod.buildContextReport(session)).toContain("推定できませんでした");
  });

  it("推定値と metadata.last_compaction_at から整形する", async () => {
    vi.mocked(estimateContextTokens).mockResolvedValue(estimate);
    const at = Date.UTC(2026, 7, 13, 12, 0, 0);
    const report = await mod.buildContextReport({ ...session, metadata: JSON.stringify({ last_compaction_at: at }) } as SessionRow);
    expect(report).toContain("(25%)");
    expect(report).toContain("2026-08-13T12:00:00.000Z");
  });

  it("CONCORDIA_COMPACTION_AUTO_PCT がしきい値表示に反映される", async () => {
    vi.stubEnv("CONCORDIA_COMPACTION_AUTO_PCT", "50");
    vi.mocked(estimateContextTokens).mockResolvedValue(estimate);
    const report = await mod.buildContextReport(session);
    // 50% = 100,000 tokens、現在 50,000 → 余裕 50,000。
    expect(report).toContain(`自動発火しきい値まで: ${(50_000).toLocaleString()} tokens (50% threshold)`);
  });
});
