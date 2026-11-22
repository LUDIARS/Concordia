// vitest.config.ts は isolate:false なので module registry がファイル間で共有される。
// 先に別ファイルが本物の依存で読んだ実装が残っていると、この file の vi.mock が効かず
// 本物の使用量取得や CLI 起動が走る (全体実行でだけ落ちる)。各テストで resetModules して
// import し直し、この file の mock 実体だけを見るようにする (context-report.test.ts と同じ形)。
import { beforeEach, expect, it, vi } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
vi.mock("../config/claude-availability.js", () => ({ isClaudeDisabled: () => false }));
vi.mock("../rules/available-text-runner.js", () => ({ runAvailableText: vi.fn() }));
vi.mock("./aggregator.js", () => ({
  dayRange: () => ({ startTs: 0, endTs: 1 }),
  aggregateDay: () => ({ date_iso: "2026-10-22", session_count: 1, total_duration_sec: 10, projects: [], roles: [], outcomes: {} }),
}));
let generateDayReport: typeof import("./generator.js")["generateDayReport"];
let runAvailableText: typeof import("../rules/available-text-runner.js")["runAvailableText"];
beforeEach(async () => {
  vi.resetModules();
  ({ runAvailableText } = await import("../rules/available-text-runner.js"));
  ({ generateDayReport } = await import("./generator.js"));
});
it("publishes a provider-neutral narrative with the existing report shape", async () => {
  const summary = "A complete daily narrative that describes the work performed.";
  vi.mocked(runAvailableText).mockResolvedValue({ ok: true, stdout: summary, stderr: "", exit_code: 0, duration_ms: 1 });
  const repo = { listSessionsInRange: () => [] } as unknown as SessionsRepo;
  expect(await generateDayReport("2026-10-22", repo)).toMatchObject({ summary_md: summary, session_count: 1 });
  expect(runAvailableText).toHaveBeenCalledTimes(1);
});
